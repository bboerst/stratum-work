package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// The recorder follows the node's mempool through the ZMQ `sequence` topic (doc/zmq.md):
//
//	<txid>A<mempool seq>   added to the mempool
//	<txid>R<mempool seq>   removed for any reason except block inclusion
//	<hash>C / <hash>D      block connected / disconnected (no mempool sequence)
//
// Transactions mined in a block get no R: the C implies their removal. Every message also carries a per-topic
// message counter (the 4-byte LE third frame); a gap means ZMQ dropped messages, and the recorder resyncs.
//
// Startup and resync follow the race-free pattern Core documents for `getrawmempool false true` (txids with
// mempool_sequence; Core refuses the sequence with verbose output, so entries come from batched getmempoolentry):
// subscribe first, take the snapshot (sequence N), then apply the buffered A/R events with a mempool sequence of
// N or more (the snapshot already reflects those below N).
//
// Removal reasons. An R carries no reason, so it's inferred from what surrounds it (Core 32.x ordering, see
// validation.cpp: a replacement's conflicts are removed, then expiry and size trimming run, then the new
// transaction's A is published; a package publishes its As before trimming; conflicts with a new block are
// removed before its C):
//
//	mined     in a block connected while the transaction was in our mempool (from the block itself)
//	replaced  a transaction added right after the R spends one of its inputs (RBF), or it descends from one that
//	          was replaced in the same group; replaced_by = the replacement
//	conflict  a connected block spends one of its inputs; replaced_by = the block's transaction
//	reorg     removed while a reorg was being processed (between a D and the following C)
//	expired   older than the node's -mempoolexpiry when removed (or descends from such a transaction)
//	evicted   the node was trimming its mempool to size (mempoolminfee above minrelaytxfee)
//	unknown   none of the above (e.g. the node was below its size limit, or prioritisetransaction games)
//
// Descendants removed along with a transaction inherit its reason.

const (
	reasonMined    = "mined"
	reasonReplaced = "replaced"
	reasonConflict = "conflict"
	reasonReorg    = "reorg"
	reasonExpired  = "expired"
	reasonEvicted  = "evicted"
	reasonUnknown  = "unknown"

	srcZMQ     = "zmq"     // first_seen / removed_at observed on the ZMQ feed (receipt time, µs)
	srcMempool = "mempool" // first_seen = the node's entry time from getrawmempool (whole seconds), at a sync
	srcResync  = "resync"  // removed_at = time of the sync that found it gone (an upper bound)
)

var removalReasons = []string{reasonMined, reasonReplaced, reasonConflict, reasonReorg, reasonExpired, reasonEvicted,
	reasonUnknown}

// SeqEvent is one `sequence` message.
type SeqEvent struct {
	Kind byte   // 'A', 'R', 'C', 'D'
	Hash Hash   // internal byte order
	MSeq uint64 // mempool sequence (A and R only)
	ZSeq uint32 // ZMQ message counter
	At   int64  // receipt time, unix µs UTC
}

// RawEvent is one `rawtx` message, already parsed (nil Tx if it couldn't be).
type RawEvent struct {
	Tx   *Tx
	ZSeq uint32
	At   int64
}

// ── What the recorder emits (in order) to the write pipeline ────────────────────────────────────────────────────

type TxRow struct {
	FirstSeen    int64 // µs
	FirstSeenSrc string
	Txid, Wtxid  Hash
	HaveWtxid    bool
	Size         int // 0 = unknown
	VSize        int
	Weight       int
	Entry        *MempoolEntry // fees and ancestor/descendant stats; nil until enriched (or if the tx left first)
	Inputs       []byte
	Raw          []byte
	NeedFees     bool // enrich with getmempoolentry
	NeedRaw      bool // no rawtx message arrived: enrich with getrawtransaction
}

type Removal struct {
	Txid        Hash
	FirstSeen   int64 // with Txid, identifies the row
	RemovedAt   int64
	Reason, Src string
	By          *Hash // replaced / conflict: the spending transaction
	Block       *Hash // mined / conflict
	Height      int
}

type OffTx struct {
	Txid     Hash
	Position int // index in the block (the coinbase is 0 and never listed)
}

type BlockRow struct {
	SeenAt      int64
	Hash        Hash
	Height      int // -1 = unknown
	Event       string
	TxCount     int
	FromMempool int     // transactions removed from our mempool as mined
	Candidates  []OffTx // block transactions not in our mempool when it connected
	Checked     bool    // false: we weren't fully synced, so Candidates aren't recorded as off-mempool
}

type Op struct {
	Insert *TxRow
	Remove *Removal
	Block  *BlockRow
}

// ── Dependencies ────────────────────────────────────────────────────────────────────────────────────────────────

type Node interface {
	MempoolSnapshot(ctx context.Context, fn func(MempoolEntry)) (uint64, error)
	RawTransactions(ctx context.Context, txids []Hash, keepRaw bool) (map[Hash]*Tx, error)
	MempoolInfo(ctx context.Context) (*MempoolInfo, error)
	Block(ctx context.Context, hash Hash) (*Block, error)
	BlockHeader(ctx context.Context, hash Hash) (*BlockHeader, error)
	BlockHash(ctx context.Context, height int) (Hash, error)
	BlockCount(ctx context.Context) (int, error)
}

type OpenTx struct {
	Txid      Hash
	FirstSeen int64
	Inputs    []byte
}

// Store gives the recorder its previous state after a restart: rows still open (removed_at IS NULL) and the last
// block it recorded.
type Store interface {
	OpenTxs(ctx context.Context, since time.Time) ([]OpenTx, error)
	LastBlock(ctx context.Context) (Hash, int, bool, error)
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────────────────────

// txState is all the recorder keeps per mempool transaction: when the row was created (its key with the txid) and
// the inputs (for replacement and conflict detection). Fees, sizes etc. go straight to the database.
type txState struct {
	firstSeen int64
	inputs    []byte
}

type pendingR struct {
	txid   Hash
	st     txState
	at     int64
	reorg  bool
	reason string
	by     *Hash
	block  *Hash
	height int
}

type RecorderConfig struct {
	KeepRaw          bool
	Expiry           time.Duration // node's -mempoolexpiry
	RawWait          time.Duration // how long an A waits for its rawtx message
	Quiet            time.Duration // pending removals are classified after this long without sequence events
	ReconcileEvery   time.Duration
	ReconcileTol     int // tracked vs getmempoolinfo.size difference tolerated (events in flight)
	ReconcileStrikes int // consecutive checks over the tolerance before a resync
	ResyncMaxBlocks  int // blocks scanned at a resync to tell mined from unknown for transactions that left
	OpenLookback     time.Duration
	RawCacheSize     int
	RawCacheAge      time.Duration
	FetchBatch       int
}

func DefaultRecorderConfig() RecorderConfig {
	return RecorderConfig{Expiry: 336 * time.Hour, RawWait: 250 * time.Millisecond, Quiet: time.Second,
		ReconcileEvery: 30 * time.Second, ReconcileTol: 25, ReconcileStrikes: 3, ResyncMaxBlocks: 144,
		OpenLookback: 15 * 24 * time.Hour, RawCacheSize: 50_000, RawCacheAge: 2 * time.Minute, FetchBatch: 500}
}

type Recorder struct {
	cfg   RecorderConfig
	node  Node
	store Store
	emit  func(Op)
	log   *slog.Logger
	M     *Metrics
	now   func() int64 // µs; replaceable in tests

	seqCh <-chan SeqEvent
	rawCh <-chan RawEvent

	txs     map[Hash]txState
	spends  map[uint64]Hash // outpoint key -> spending mempool tx
	loaded  bool            // previous state taken from the store (first sync only)
	synced  bool
	syncAt  int64
	lastMSq uint64
	held    *SeqEvent // event that revealed a gap, applied after the resync

	zSeq, zRaw     uint32
	haveZ, haveRaw bool

	pending          []pendingR
	pendIdx          map[uint64]int
	sawA, sawC       bool
	inReorg          bool
	lastSeqEvent     int64
	tipHash          Hash
	tipHeight        int
	haveTip          bool
	info             *MempoolInfo
	infoAt           int64
	strikes          int
	lastReconcile    int64
	lastReconcileOK  atomic.Int64
	resyncCause      string
	rawCache         map[Hash]*Tx
	rawOrder         []rawRef
	rawStart         int
	mu               sync.Mutex // guards the snapshot of numbers read by /metrics
	trackedForMetric int
}

type rawRef struct {
	txid Hash
	at   int64
}

func NewRecorder(cfg RecorderConfig, node Node, store Store, emit func(Op), seq <-chan SeqEvent, raw <-chan RawEvent,
	m *Metrics, log *slog.Logger) *Recorder {
	return &Recorder{cfg: cfg, node: node, store: store, emit: emit, log: log, M: m, seqCh: seq, rawCh: raw,
		now: func() int64 { return time.Now().UnixMicro() }, txs: map[Hash]txState{}, spends: map[uint64]Hash{},
		pendIdx: map[uint64]int{}, rawCache: map[Hash]*Tx{}, tipHeight: -1, resyncCause: "startup"}
}

// outpointKey hashes a prevout to 64 bits for the spends index. The txid bytes are already uniform; lookups verify
// the full outpoint, so a collision can only cost a missed match, never a wrong one.
func outpointKey(o []byte) uint64 {
	return binary.LittleEndian.Uint64(o[:8]) ^ uint64(binary.LittleEndian.Uint32(o[32:36]))*0x9E3779B97F4A7C15
}

func hasOutpoint(inputs, o []byte) bool {
	for i := 0; i+OutpointLen <= len(inputs); i += OutpointLen {
		if string(inputs[i:i+OutpointLen]) == string(o) {
			return true
		}
	}
	return false
}

func (r *Recorder) index(txid Hash, inputs []byte) {
	for i := 0; i+OutpointLen <= len(inputs); i += OutpointLen {
		r.spends[outpointKey(inputs[i:i+OutpointLen])] = txid
	}
}

func (r *Recorder) unindex(txid Hash, inputs []byte) {
	for i := 0; i+OutpointLen <= len(inputs); i += OutpointLen {
		k := outpointKey(inputs[i : i+OutpointLen])
		if r.spends[k] == txid {
			delete(r.spends, k)
		}
	}
}

// Tracked is the number of transactions the recorder believes are in the node's mempool.
func (r *Recorder) Tracked() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.trackedForMetric
}

func (r *Recorder) publish() {
	r.mu.Lock()
	r.trackedForMetric = len(r.txs)
	r.mu.Unlock()
	r.M.Synced.Store(r.synced)
}

// ── Main loop ───────────────────────────────────────────────────────────────────────────────────────────────────

func (r *Recorder) Run(ctx context.Context) {
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	backoff := time.Second
	for ctx.Err() == nil {
		if !r.synced {
			if err := r.Resync(ctx); err != nil {
				if ctx.Err() != nil {
					return
				}
				r.log.Error("mempool sync failed, retrying", "in", backoff, "err", err)
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
				}
				backoff = min(backoff*2, time.Minute)
				continue
			}
			backoff = time.Second
			if h := r.held; h != nil {
				r.held = nil
				r.HandleSeq(ctx, *h)
			}
		}
		select {
		case <-ctx.Done():
			return
		case ev := <-r.seqCh:
			r.HandleSeq(ctx, ev)
		case ev := <-r.rawCh:
			r.HandleRaw(ev)
		case <-tick.C:
			r.Tick(ctx)
		}
		r.publish()
	}
}

// ── rawtx ───────────────────────────────────────────────────────────────────────────────────────────────────────

func (r *Recorder) HandleRaw(ev RawEvent) {
	if r.haveRaw && ev.ZSeq != r.zRaw+1 {
		r.M.Gaps.Add("rawtx", 1)
	}
	r.zRaw, r.haveRaw = ev.ZSeq, true
	if ev.Tx == nil {
		return
	}
	tx := ev.Tx
	// A late rawtx for a transaction we already track without inputs: fill them in.
	if st, ok := r.txs[tx.Txid]; ok && st.inputs == nil {
		st.inputs = tx.Inputs
		r.txs[tx.Txid] = st
		r.index(tx.Txid, tx.Inputs)
		return
	}
	if _, ok := r.rawCache[tx.Txid]; !ok {
		r.rawOrder = append(r.rawOrder, rawRef{tx.Txid, ev.At})
	}
	r.rawCache[tx.Txid] = tx
	r.trimRawCache(ev.At)
}

func (r *Recorder) trimRawCache(now int64) {
	cut := now - r.cfg.RawCacheAge.Microseconds()
	for r.rawStart < len(r.rawOrder) {
		o := r.rawOrder[r.rawStart]
		if len(r.rawCache) <= r.cfg.RawCacheSize && o.at >= cut {
			break
		}
		delete(r.rawCache, o.txid)
		r.rawStart++
	}
	if r.rawStart > 4096 && r.rawStart*2 > len(r.rawOrder) {
		r.rawOrder = append([]rawRef(nil), r.rawOrder[r.rawStart:]...)
		r.rawStart = 0
	}
}

// rawFor returns the parsed transaction for an A: from the cache, or by waiting briefly for its rawtx message (it's
// published just before the A, on another socket). Only rawtx messages are consumed while waiting, so sequence
// events keep their order.
func (r *Recorder) rawFor(txid Hash) *Tx {
	take := func() *Tx {
		if tx, ok := r.rawCache[txid]; ok {
			delete(r.rawCache, txid)
			return tx
		}
		return nil
	}
	if tx := take(); tx != nil {
		return tx
	}
	if r.rawCh == nil || r.cfg.RawWait <= 0 {
		return nil
	}
	deadline := time.NewTimer(r.cfg.RawWait)
	defer deadline.Stop()
	for {
		select {
		case ev := <-r.rawCh:
			r.HandleRaw(ev)
			if tx := take(); tx != nil {
				return tx
			}
		case <-deadline.C:
			return nil
		}
	}
}

// ── sequence ────────────────────────────────────────────────────────────────────────────────────────────────────

func (r *Recorder) HandleSeq(ctx context.Context, ev SeqEvent) {
	r.M.Events.Add(string(ev.Kind), 1)
	r.M.LastEventUs.Store(ev.At)
	if r.haveZ && ev.ZSeq != r.zSeq+1 && r.synced {
		r.M.Gaps.Add("sequence", 1)
		r.log.Warn("ZMQ sequence gap: messages were dropped, resyncing", "expected", r.zSeq+1, "got", ev.ZSeq)
		r.haveZ = false // the held event restarts the count
		r.held = &ev
		r.markUnsynced("gap")
		return
	}
	r.zSeq, r.haveZ = ev.ZSeq, true
	r.lastSeqEvent = ev.At
	switch ev.Kind {
	case 'A', 'R':
		if ev.MSeq <= r.lastMSq {
			r.M.Stale.Add(1) // already in the snapshot (buffered during the sync), or a replay
			return
		}
		r.lastMSq = ev.MSeq
		if ev.Kind == 'A' {
			r.added(ev)
		} else {
			r.removed(ev)
		}
	case 'C':
		r.connected(ctx, ev)
	case 'D':
		r.disconnected(ctx, ev)
	}
}

func (r *Recorder) markUnsynced(cause string) {
	r.synced = false
	r.resyncCause = cause
	r.M.Synced.Store(false)
}

func (r *Recorder) added(ev SeqEvent) {
	if len(r.pending) > 0 && r.sawC && !r.inReorg {
		r.finalize()
	}
	if _, dup := r.txs[ev.Hash]; dup {
		r.M.Duplicates.Add(1)
		return
	}
	tx := r.rawFor(ev.Hash)
	row := &TxRow{FirstSeen: ev.At, FirstSeenSrc: srcZMQ, Txid: ev.Hash, NeedFees: true}
	st := txState{firstSeen: ev.At}
	if tx != nil {
		row.Wtxid, row.HaveWtxid, row.Size, row.Weight, row.VSize = tx.Wtxid, true, tx.Size, tx.Weight, tx.VSize()
		row.Inputs, row.Raw = tx.Inputs, tx.Raw
		st.inputs = tx.Inputs
	} else {
		row.NeedRaw = true
		r.M.RawMissing.Add(1)
	}
	// Replacement: this transaction spends an input of one removed just before it.
	for i := 0; i+OutpointLen <= len(st.inputs); i += OutpointLen {
		o := st.inputs[i : i+OutpointLen]
		if j, ok := r.pendIdx[outpointKey(o)]; ok && r.pending[j].reason == "" && hasOutpoint(r.pending[j].st.inputs, o) {
			by := ev.Hash
			r.pending[j].reason, r.pending[j].by = reasonReplaced, &by
		}
	}
	r.txs[ev.Hash] = st
	r.index(ev.Hash, st.inputs)
	r.sawA = len(r.pending) > 0 // sawA/sawC: what followed the current pending group
	r.M.Added.Add(srcZMQ, 1)
	r.emit(Op{Insert: row})
}

func (r *Recorder) removed(ev SeqEvent) {
	if len(r.pending) > 0 && (r.sawA || r.sawC) && !r.inReorg {
		r.finalize()
	}
	st, ok := r.txs[ev.Hash]
	if !ok {
		// E.g. a new transaction trimmed right away by size limiting: Core publishes its R but never an A.
		r.M.UnknownRemovals.Add(1)
		return
	}
	delete(r.txs, ev.Hash)
	r.unindex(ev.Hash, st.inputs)
	r.pending = append(r.pending, pendingR{txid: ev.Hash, st: st, at: ev.At, reorg: r.inReorg, height: -1})
	for i := 0; i+OutpointLen <= len(st.inputs); i += OutpointLen {
		r.pendIdx[outpointKey(st.inputs[i:i+OutpointLen])] = len(r.pending) - 1
	}
}

// fetchBlock gets a block and its height, retrying briefly.
func (r *Recorder) fetchBlock(ctx context.Context, hash Hash) (*Block, int, error) {
	var err error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, -1, ctx.Err()
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}
		var blk *Block
		var hdr *BlockHeader
		if blk, err = r.node.Block(ctx, hash); err != nil {
			continue
		}
		if hdr, err = r.node.BlockHeader(ctx, hash); err != nil {
			continue
		}
		return blk, hdr.Height, nil
	}
	return nil, -1, err
}

func (r *Recorder) connected(ctx context.Context, ev SeqEvent) {
	blk, height, err := r.fetchBlock(ctx, ev.Hash)
	if err != nil {
		// Without the block we can't tell which transactions it mined: resync (its catch-up scan classifies them).
		r.log.Error("could not fetch a connected block; resyncing", "block", ev.Hash, "err", err)
		r.markUnsynced("block_fetch")
		return
	}
	r.M.Blocks.Add("connect", 1)
	// Conflicts: pending removals whose inputs this block spends.
	if len(r.pending) > 0 {
		for _, btx := range blk.Txs[1:] {
			for i := 0; i < btx.NumInputs(); i++ {
				o := btx.Inputs[i*OutpointLen : (i+1)*OutpointLen]
				if j, ok := r.pendIdx[outpointKey(o)]; ok && r.pending[j].reason == "" && hasOutpoint(r.pending[j].st.inputs, o) {
					by, bh := btx.Txid, blk.Hash
					p := &r.pending[j]
					p.reason, p.by, p.block, p.height = reasonConflict, &by, &bh, height
				}
			}
		}
	}
	reliable := r.synced && ev.At >= r.syncAt
	row := &BlockRow{SeenAt: ev.At, Hash: blk.Hash, Height: height, Event: "connect", TxCount: len(blk.Txs),
		Checked: reliable}
	bh := blk.Hash
	for pos, btx := range blk.Txs {
		if pos == 0 {
			continue
		}
		st, ok := r.txs[btx.Txid]
		if !ok {
			row.Candidates = append(row.Candidates, OffTx{Txid: btx.Txid, Position: pos})
			continue
		}
		delete(r.txs, btx.Txid)
		r.unindex(btx.Txid, st.inputs)
		row.FromMempool++
		r.M.Removed.Add(reasonMined, 1)
		r.emit(Op{Remove: &Removal{Txid: btx.Txid, FirstSeen: st.firstSeen, RemovedAt: ev.At, Reason: reasonMined,
			Src: srcZMQ, Block: &bh, Height: height}})
	}
	if reliable {
		r.M.OffMempoolCandidates.Add(int64(len(row.Candidates)))
	}
	r.emit(Op{Block: row})
	r.tipHash, r.tipHeight, r.haveTip = blk.Hash, height, true
	r.sawC = len(r.pending) > 0
	r.inReorg = false
}

func (r *Recorder) disconnected(ctx context.Context, ev SeqEvent) {
	if len(r.pending) > 0 && (r.sawA || r.sawC) && !r.inReorg {
		r.finalize()
	}
	height := -1
	if hdr, err := r.node.BlockHeader(ctx, ev.Hash); err == nil {
		height = hdr.Height
	}
	r.M.Blocks.Add("disconnect", 1)
	r.log.Info("block disconnected (reorg)", "block", ev.Hash, "height", height)
	r.emit(Op{Block: &BlockRow{SeenAt: ev.At, Hash: ev.Hash, Height: height, Event: "disconnect"}})
	r.inReorg = true
	if height > 0 {
		r.tipHeight, r.haveTip = height-1, false
	}
}

// mempoolFull reports whether the node has been trimming to size, from a getmempoolinfo taken after `after` (the
// removal's receipt time): a cached answer from before the removal could predate the first trim.
func (r *Recorder) mempoolFull(ctx context.Context, after int64) bool {
	if r.info == nil || r.infoAt < after {
		if info, err := r.node.MempoolInfo(ctx); err == nil {
			r.info, r.infoAt = info, r.now()
		}
	}
	return r.info != nil && r.info.Full()
}

// finalize classifies the pending removals and emits them.
func (r *Recorder) finalize() {
	if len(r.pending) == 0 {
		r.sawA, r.sawC = false, false
		return
	}
	byTxid := make(map[Hash]int, len(r.pending))
	for i, p := range r.pending {
		byTxid[p.txid] = i
	}
	parent := func(i int) (int, bool) { // a pending transaction this one spends from
		in := r.pending[i].st.inputs
		for k := 0; k+OutpointLen <= len(in); k += OutpointLen {
			if j, ok := byTxid[Hash(in[k:k+32])]; ok && j != i {
				return j, true
			}
		}
		return 0, false
	}
	var full *bool
	for changed := true; changed; {
		changed = false
		for i := range r.pending {
			p := &r.pending[i]
			if p.reason != "" {
				continue
			}
			if j, ok := parent(i); ok {
				if q := r.pending[j]; q.reason != "" {
					p.reason, p.by, p.block, p.height = q.reason, q.by, q.block, q.height
					changed = true
				}
				continue // wait for the parent's reason
			}
			switch {
			case p.reorg:
				p.reason = reasonReorg
			case time.Duration(p.at-p.st.firstSeen)*time.Microsecond >= r.cfg.Expiry-time.Minute:
				p.reason = reasonExpired
			default:
				if full == nil {
					last := int64(0)
					for _, q := range r.pending {
						last = max(last, q.at)
					}
					f := r.mempoolFull(context.Background(), last)
					full = &f
				}
				if *full {
					p.reason = reasonEvicted
				} else {
					p.reason = reasonUnknown
				}
			}
			changed = true
		}
	}
	for _, p := range r.pending {
		if p.reason == "" { // only possible with a dependency cycle, which valid transactions can't form
			p.reason = reasonUnknown
		}
		r.M.Removed.Add(p.reason, 1)
		r.emit(Op{Remove: &Removal{Txid: p.txid, FirstSeen: p.st.firstSeen, RemovedAt: p.at, Reason: p.reason,
			Src: srcZMQ, By: p.by, Block: p.block, Height: p.height}})
	}
	r.pending = r.pending[:0]
	clear(r.pendIdx)
	r.sawA, r.sawC = false, false
}

// Tick runs the timers: classifying removals after a quiet period, and the periodic reconciliation.
func (r *Recorder) Tick(ctx context.Context) {
	now := r.now()
	if len(r.pending) > 0 {
		quiet := r.cfg.Quiet
		if r.inReorg {
			quiet *= 10
		}
		if now-r.lastSeqEvent >= quiet.Microseconds() {
			r.finalize()
		}
	}
	r.trimRawCache(now)
	if r.synced && now-r.lastReconcile >= r.cfg.ReconcileEvery.Microseconds() {
		r.lastReconcile = now
		r.reconcile(ctx)
	}
}

// reconcile compares the tracked set with getmempoolinfo.size and resyncs after repeated drift.
func (r *Recorder) reconcile(ctx context.Context) {
	info, err := r.node.MempoolInfo(ctx)
	if err != nil {
		r.log.Warn("reconciliation: getmempoolinfo failed", "err", err)
		return
	}
	r.info, r.infoAt = info, r.now()
	r.lastReconcileOK.Store(r.now())
	r.M.NodeTxs.Store(int64(info.Size))
	r.M.NodeBytes.Store(info.Bytes)
	tracked := len(r.txs)
	diff := tracked - info.Size
	if diff < 0 {
		diff = -diff
	}
	if diff <= r.cfg.ReconcileTol {
		r.strikes = 0
		return
	}
	r.strikes++
	r.log.Warn("tracked mempool differs from the node", "tracked", tracked, "node", info.Size, "strike", r.strikes)
	if r.strikes >= r.cfg.ReconcileStrikes {
		r.strikes = 0
		r.markUnsynced("drift")
	}
}

// ── Sync ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Resync rebuilds the tracked set from a node snapshot. The previous state is the in-memory set, or after a
// restart the rows the database still has open. Transactions in both keep their row; those only in the snapshot
// get a new row (first_seen = the node's entry time); those only in the previous state are closed (mined if in a
// block connected since the last one we recorded, else unknown).
func (r *Recorder) Resync(ctx context.Context) error {
	start := time.Now()
	cause := r.resyncCause
	r.finalize()
	if !r.loaded && r.store != nil {
		open, err := r.store.OpenTxs(ctx, time.Now().Add(-r.cfg.OpenLookback))
		if err != nil {
			return fmt.Errorf("loading open transactions: %w", err)
		}
		prev := make(map[Hash]txState, len(open))
		for _, o := range open {
			if cur, ok := prev[o.Txid]; !ok || o.FirstSeen > cur.firstSeen {
				prev[o.Txid] = txState{firstSeen: o.FirstSeen, inputs: o.Inputs}
			}
		}
		if h, height, ok, err := r.store.LastBlock(ctx); err == nil && ok {
			r.tipHash, r.tipHeight, r.haveTip = h, height, true
		}
		r.txs, r.spends = prev, make(map[uint64]Hash, len(prev)*2)
		for txid, st := range prev {
			r.index(txid, st.inputs)
		}
		r.loaded = true
		r.log.Info("previous state from the database", "open_rows", len(open))
	}
	prev := r.txs

	// Stream the snapshot, keeping little for transactions we already track (the common case): just that they're
	// still there. Only new ones (or ones that left and came back: the node's entry time well after our row's)
	// keep their entry, for the new row.
	seen := make(map[Hash]struct{}, len(prev))
	fresh := map[Hash]MempoolEntry{}
	seq, err := r.node.MempoolSnapshot(ctx, func(e MempoolEntry) {
		// Time 0: the entry was gone by the time it was looked up (its R follows on the feed).
		if st, ok := prev[e.Txid]; ok && (e.Time == 0 || e.Time*1_000_000 <= st.firstSeen+120_000_000) {
			seen[e.Txid] = struct{}{}
			return
		}
		fresh[e.Txid] = e
	})
	if err != nil {
		return err
	}
	syncAt := r.now()
	tip, err := r.node.BlockCount(ctx)
	if err != nil {
		return err
	}
	var gone []Hash // rows to close: departed, or superseded by a new stay
	for txid := range prev {
		if _, ok := seen[txid]; !ok {
			gone = append(gone, txid)
		}
	}

	// Blocks connected since the last one we saw: which of the departed transactions they mined.
	type minedIn struct {
		hash   Hash
		height int
	}
	mined := map[Hash]minedIn{}
	if len(gone) > 0 {
		from := tip - 5
		if r.haveTip {
			if hdr, err := r.node.BlockHeader(ctx, r.tipHash); err == nil && hdr.Confirmations > 0 {
				from = r.tipHeight + 1
			} else if r.tipHeight >= 0 {
				from = r.tipHeight - 5 // our last block was reorged out: rescan a few below it
			}
		} else if r.tipHeight >= 0 {
			from = r.tipHeight - 5
		}
		from = max(from, tip-r.cfg.ResyncMaxBlocks+1, 0)
		for h := from; h <= tip; h++ {
			hash, err := r.node.BlockHash(ctx, h)
			if err != nil {
				return err
			}
			blk, err := r.node.Block(ctx, hash)
			if err != nil {
				return err
			}
			for _, t := range blk.Txs {
				if _, ok := prev[t.Txid]; ok {
					mined[t.Txid] = minedIn{hash, h}
				}
			}
		}
	}

	// Inputs (and size) for the new rows, and for kept rows that never got their inputs.
	var need []Hash
	for txid := range fresh {
		need = append(need, txid)
	}
	for txid := range seen {
		if prev[txid].inputs == nil {
			need = append(need, txid)
		}
	}
	got := make(map[Hash]*Tx, len(need))
	for i := 0; i < len(need); i += r.cfg.FetchBatch {
		part, err := r.node.RawTransactions(ctx, need[i:min(i+r.cfg.FetchBatch, len(need))], r.cfg.KeepRaw)
		if err != nil {
			return err
		}
		for k, v := range part {
			got[k] = v
		}
	}

	// Every RPC succeeded: apply.
	closed := map[string]int{}
	for _, txid := range gone {
		st := prev[txid]
		_, isMined := mined[txid]
		_, reAdded := fresh[txid]
		rm := &Removal{Txid: txid, FirstSeen: st.firstSeen, RemovedAt: max(syncAt, st.firstSeen), Reason: reasonUnknown,
			Src: srcResync, Height: -1}
		if b := mined[txid]; isMined && !reAdded {
			bh := b.hash
			rm.Reason, rm.Block, rm.Height = reasonMined, &bh, b.height
		}
		closed[rm.Reason]++
		r.M.Removed.Add(rm.Reason, 1)
		r.emit(Op{Remove: rm})
		delete(r.txs, txid)
		r.unindex(txid, st.inputs)
	}
	for txid := range seen {
		if st := r.txs[txid]; st.inputs == nil {
			if tx, ok := got[txid]; ok {
				st.inputs = tx.Inputs
				r.txs[txid] = st
				r.index(txid, st.inputs)
			}
		}
	}
	for txid, e := range fresh {
		e := e
		row := &TxRow{FirstSeen: e.Time * 1_000_000, FirstSeenSrc: srcMempool, Txid: txid, Wtxid: e.Wtxid,
			HaveWtxid: true, VSize: e.VSize, Weight: e.Weight, Entry: &e}
		if e.Time == 0 { // no entry: left right after the snapshot; recorded at the sync time
			row.FirstSeen, row.HaveWtxid, row.Entry = syncAt, false, nil
		}
		st := txState{firstSeen: row.FirstSeen}
		if tx, ok := got[txid]; ok {
			row.Size, row.Inputs, row.Raw = tx.Size, tx.Inputs, tx.Raw
			if row.Weight == 0 {
				row.Weight, row.VSize = tx.Weight, tx.VSize()
			}
			if !row.HaveWtxid {
				row.Wtxid, row.HaveWtxid = tx.Wtxid, true
			}
			st.inputs = tx.Inputs
		}
		r.txs[txid] = st
		r.index(txid, st.inputs)
		r.M.Added.Add(srcMempool, 1)
		r.emit(Op{Insert: row})
	}

	r.loaded = true
	// The snapshot reflects every event below its sequence; the next event carries exactly seq (Core assigns
	// m_sequence_number++), so apply MSeq >= seq.
	r.lastMSq = 0
	if seq > 0 {
		r.lastMSq = seq - 1
	}
	r.synced, r.syncAt = true, syncAt
	r.sawA, r.sawC, r.inReorg = false, false, false
	r.strikes = 0
	r.lastReconcile = r.now()
	r.lastReconcileOK.Store(r.now())
	if !r.haveTip || r.tipHeight < tip {
		if h, err := r.node.BlockHash(ctx, tip); err == nil {
			r.tipHash, r.tipHeight, r.haveTip = h, tip, true
		}
	}
	r.M.Resyncs.Add(cause, 1)
	r.publish()
	r.log.Info("mempool synced", "cause", cause, "mempool_sequence", seq, "txs", len(r.txs), "new_rows", len(fresh),
		"closed", closed, "kept", len(seen), "took", time.Since(start).Round(time.Millisecond))
	return nil
}
