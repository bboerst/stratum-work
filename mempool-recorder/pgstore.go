package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Postgres: one transaction per batch of ops. New rows go in with COPY (through a temp table, so a row that already
// exists after a retry is skipped), removals close rows with one UPDATE ... FROM, and each block's off-mempool
// candidates are checked against mempool_txs inside the database, so the count is exactly what was written.

type PGConfig struct {
	Host, Port, Database, User, Password, SSLMode string
	ConnectTimeout                                time.Duration
	OffMempoolLookback                            time.Duration // how far back a block tx counts as "seen"
}

func pgConnect(ctx context.Context, cfg PGConfig) (*pgx.Conn, error) {
	// Keyword DSN without the password (set on the config), so an error can never echo it.
	if _, err := strconv.Atoi(cfg.Port); err != nil {
		return nil, fmt.Errorf("invalid PG_PORT %q", cfg.Port)
	}
	cc, err := pgx.ParseConfig(fmt.Sprintf("host=%s port=%s dbname=%s user=%s sslmode=%s",
		dsnQuote(cfg.Host), cfg.Port, dsnQuote(cfg.Database), dsnQuote(cfg.User), dsnQuote(cfg.SSLMode)))
	if err != nil {
		return nil, errors.New("invalid Postgres settings") // never echo the DSN
	}
	cc.Password = cfg.Password
	cc.RuntimeParams["application_name"] = "stratum-work-mempool-recorder"
	cc.ConnectTimeout = cfg.ConnectTimeout
	return pgx.ConnectConfig(ctx, cc)
}

func dsnQuote(s string) string {
	q := "'"
	for _, r := range s {
		if r == '\'' || r == '\\' {
			q += `\`
		}
		q += string(r)
	}
	return q + "'"
}

type PGStore struct {
	cfg  PGConfig
	conn *pgx.Conn
}

func NewPGStore(cfg PGConfig) *PGStore { return &PGStore{cfg: cfg} }

func (s *PGStore) ensure(ctx context.Context) error {
	if s.conn != nil && !s.conn.IsClosed() {
		return nil
	}
	c, err := pgConnect(ctx, s.cfg)
	if err != nil {
		return err
	}
	// Staging tables for this session (emptied at every commit).
	if _, err := c.Exec(ctx, `
		CREATE TEMP TABLE mr_ins (LIKE mempool_txs) ON COMMIT DELETE ROWS;
		CREATE TEMP TABLE mr_rm (txid bytea, first_seen timestamptz, removed_at timestamptz, removal text,
			removed_src text, replaced_by bytea, block_hash bytea, block_height integer) ON COMMIT DELETE ROWS`); err != nil {
		_ = c.Close(ctx)
		return err
	}
	s.conn = c
	return nil
}

func (s *PGStore) Close() {
	if s.conn != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.conn.Close(ctx)
		s.conn = nil
	}
}

var insertColumns = []string{"first_seen", "first_seen_src", "txid", "wtxid", "size", "vsize", "weight", "fee",
	"modified_fee", "ancestor_count", "ancestor_size", "ancestor_fees", "descendant_count", "descendant_size",
	"descendant_fees", "inputs"}

func ts(us int64) time.Time { return time.UnixMicro(us).UTC() }

func nzInt(v int) any {
	if v <= 0 {
		return nil
	}
	return int32(v)
}

func hashOrNil(h *Hash) any {
	if h == nil {
		return nil
	}
	return h[:]
}

func (r *TxRow) values() []any {
	var wtxid any
	if r.HaveWtxid {
		w := r.Wtxid
		wtxid = w[:]
	}
	inputs := r.Inputs
	if inputs == nil {
		inputs = []byte{}
	}
	txid := r.Txid
	v := []any{ts(r.FirstSeen), r.FirstSeenSrc, txid[:], wtxid, nzInt(r.Size), nzInt(r.VSize), nzInt(r.Weight),
		nil, nil, nil, nil, nil, nil, nil, nil, inputs}
	if e := r.Entry; e != nil {
		v[7], v[8] = e.Fee, e.ModFee
		v[9], v[10], v[11] = int32(e.AncestorCount), int32(e.AncestorSize), e.AncestorFees
		v[12], v[13], v[14] = int32(e.DescendantCount), int32(e.DescendantSize), e.DescendantFees
	}
	return v
}

func (s *PGStore) Write(ctx context.Context, ops []Op, keepRaw bool) error {
	if err := s.ensure(ctx); err != nil {
		return err
	}
	err := s.write(ctx, ops, keepRaw)
	if err != nil {
		s.Close() // reconnect next time (also resets a broken session)
	}
	return err
}

func (s *PGStore) write(ctx context.Context, ops []Op, keepRaw bool) error {
	var ins, raw, rm [][]any
	var blocks []*BlockRow
	minFirst := int64(1<<63 - 1)
	for _, op := range ops {
		switch {
		case op.Insert != nil:
			ins = append(ins, op.Insert.values())
			if keepRaw && op.Insert.Raw != nil {
				t := op.Insert.Txid
				raw = append(raw, []any{ts(op.Insert.FirstSeen), t[:], op.Insert.Raw})
			}
		case op.Remove != nil:
			x := op.Remove
			removed := max(x.RemovedAt, x.FirstSeen) // clocks: never before first_seen (a CHECK)
			var height any
			if x.Height >= 0 && x.Block != nil {
				height = int32(x.Height)
			}
			t := x.Txid
			rm = append(rm, []any{t[:], ts(x.FirstSeen), ts(removed), x.Reason, x.Src, hashOrNil(x.By), hashOrNil(x.Block), height})
			minFirst = min(minFirst, x.FirstSeen)
		case op.Block != nil:
			blocks = append(blocks, op.Block)
		}
	}
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if len(ins) > 0 {
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"mr_ins"}, insertColumns, pgx.CopyFromRows(ins)); err != nil {
			return fmt.Errorf("staging rows: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO mempool_txs SELECT * FROM mr_ins ON CONFLICT (txid, first_seen) DO NOTHING`); err != nil {
			return fmt.Errorf("inserting rows: %w", err)
		}
	}
	if len(raw) > 0 {
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"mempool_tx_raw"}, []string{"first_seen", "txid", "raw"}, pgx.CopyFromRows(raw)); err != nil {
			return fmt.Errorf("raw transactions: %w", err)
		}
	}
	if len(rm) > 0 {
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"mr_rm"}, []string{"txid", "first_seen", "removed_at", "removal",
			"removed_src", "replaced_by", "block_hash", "block_height"}, pgx.CopyFromRows(rm)); err != nil {
			return fmt.Errorf("staging removals: %w", err)
		}
		// The first_seen bound lets the planner skip chunks that can't hold any of these rows.
		if _, err := tx.Exec(ctx, `UPDATE mempool_txs t SET removed_at = r.removed_at, removal = r.removal::mempool_removal,
				removed_src = r.removed_src, replaced_by = r.replaced_by, block_hash = r.block_hash, block_height = r.block_height
			FROM mr_rm r WHERE t.txid = r.txid AND t.first_seen = r.first_seen AND t.removed_at IS NULL AND t.first_seen >= $1`,
			ts(minFirst)); err != nil {
			return fmt.Errorf("closing rows: %w", err)
		}
	}
	for _, b := range blocks {
		var height any
		if b.Height >= 0 {
			height = int32(b.Height)
		}
		h := b.Hash
		if b.Event == "disconnect" {
			if _, err := tx.Exec(ctx, `INSERT INTO mempool_blocks (seen_at, block_hash, height, event) VALUES ($1, $2, $3, 'disconnect')`,
				ts(b.SeenAt), h[:], height); err != nil {
				return fmt.Errorf("block row: %w", err)
			}
			continue
		}
		txids := make([][]byte, len(b.Candidates))
		pos := make([]int32, len(b.Candidates))
		for i, c := range b.Candidates {
			t := c.Txid
			txids[i], pos[i] = t[:], int32(c.Position)
		}
		if _, err := tx.Exec(ctx, `WITH ins AS (
				INSERT INTO mempool_offmempool (block_hash, height, seen_at, txid, position)
				SELECT $2, $3, $1, c.txid, c.pos FROM unnest($4::bytea[], $5::integer[]) AS c(txid, pos)
				WHERE $8 AND NOT EXISTS (SELECT 1 FROM mempool_txs t WHERE t.txid = c.txid AND t.first_seen > $1::timestamptz - $9::bigint * interval '1 second')
				ON CONFLICT DO NOTHING RETURNING 1)
			INSERT INTO mempool_blocks (seen_at, block_hash, height, event, tx_count, from_mempool, off_mempool, off_mempool_checked)
			SELECT $1, $2, $3, 'connect', $6, $7, CASE WHEN $8 THEN (SELECT count(*) FROM ins) END, $8`,
			ts(b.SeenAt), h[:], height, txids, pos, int32(b.TxCount), int32(b.FromMempool), b.Checked,
			int64(s.cfg.OffMempoolLookback.Seconds())); err != nil {
			return fmt.Errorf("block row: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// ── Store (previous state at startup), on its own short-lived connection ────────────────────────────────────────

func (s *PGStore) withConn(ctx context.Context, fn func(*pgx.Conn) error) error {
	c, err := pgConnect(ctx, s.cfg)
	if err != nil {
		return err
	}
	defer func() { _ = c.Close(context.Background()) }()
	return fn(c)
}

func (s *PGStore) OpenTxs(ctx context.Context, since time.Time) ([]OpenTx, error) {
	var out []OpenTx
	err := s.withConn(ctx, func(c *pgx.Conn) error {
		rows, err := c.Query(ctx, `SELECT txid, first_seen, inputs FROM mempool_txs WHERE removed_at IS NULL AND first_seen >= $1`, since)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var txid, inputs []byte
			var first time.Time
			if err := rows.Scan(&txid, &first, &inputs); err != nil {
				return err
			}
			if len(txid) != 32 {
				continue
			}
			o := OpenTx{Txid: Hash(txid), FirstSeen: first.UnixMicro()}
			if len(inputs) > 0 {
				o.Inputs = inputs
			}
			out = append(out, o)
		}
		return rows.Err()
	})
	return out, err
}

func (s *PGStore) LastBlock(ctx context.Context) (Hash, int, bool, error) {
	var h Hash
	var height int32
	found := false
	err := s.withConn(ctx, func(c *pgx.Conn) error {
		var b []byte
		err := c.QueryRow(ctx, `SELECT block_hash, height FROM mempool_blocks WHERE event = 'connect' AND height IS NOT NULL
			ORDER BY seen_at DESC LIMIT 1`).Scan(&b, &height)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(b) == 32 {
			h, found = Hash(b), true
		}
		return nil
	})
	return h, int(height), found, err
}
