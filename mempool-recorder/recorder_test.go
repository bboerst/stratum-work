package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────

type fakeNode struct {
	snap      []MempoolEntry
	snapSeq   uint64
	raw       map[Hash]*Tx
	blocks    map[Hash]*Block
	heights   map[Hash]int
	byHeight  map[int]Hash
	tip       int
	info      MempoolInfo
	snapCalls int
	failBlock bool
}

func newFakeNode() *fakeNode {
	return &fakeNode{raw: map[Hash]*Tx{}, blocks: map[Hash]*Block{}, heights: map[Hash]int{}, byHeight: map[int]Hash{},
		info: MempoolInfo{MempoolMinFee: "0.00001", MinRelayTxFee: "0.00001"}}
}

func (n *fakeNode) MempoolSnapshot(_ context.Context, fn func(MempoolEntry)) (uint64, error) {
	n.snapCalls++
	for _, e := range n.snap {
		fn(e)
	}
	return n.snapSeq, nil
}

func (n *fakeNode) RawTransactions(_ context.Context, txids []Hash, _ bool) (map[Hash]*Tx, error) {
	out := map[Hash]*Tx{}
	for _, t := range txids {
		if tx, ok := n.raw[t]; ok {
			out[t] = tx
		}
	}
	return out, nil
}

func (n *fakeNode) MempoolInfo(context.Context) (*MempoolInfo, error) {
	i := n.info
	return &i, nil
}

func (n *fakeNode) Block(_ context.Context, h Hash) (*Block, error) {
	if b, ok := n.blocks[h]; ok && !n.failBlock {
		return b, nil
	}
	return nil, errors.New("no block")
}

func (n *fakeNode) BlockHeader(_ context.Context, h Hash) (*BlockHeader, error) {
	height, ok := n.heights[h]
	if !ok {
		return nil, errors.New("no header")
	}
	conf := 1
	if n.byHeight[height] != h {
		conf = -1
	}
	return &BlockHeader{Hash: h.Display(), Height: height, Confirmations: conf}, nil
}

func (n *fakeNode) BlockHash(_ context.Context, height int) (Hash, error) {
	h, ok := n.byHeight[height]
	if !ok {
		return Hash{}, errors.New("no block at height")
	}
	return h, nil
}

func (n *fakeNode) BlockCount(context.Context) (int, error) { return n.tip, nil }

func (n *fakeNode) addBlock(height int, txs ...*Tx) Hash {
	h := hashOf("block", height)
	cb := &Tx{Txid: hashOf("coinbase", height), Inputs: make([]byte, OutpointLen)}
	n.blocks[h] = &Block{Hash: h, Txs: append([]*Tx{cb}, txs...)}
	n.heights[h], n.byHeight[height] = height, h
	n.tip = max(n.tip, height)
	return h
}

type fakeStore struct {
	open      []OpenTx
	lastHash  Hash
	lastH     int
	haveBlock bool
}

func (s *fakeStore) OpenTxs(context.Context, time.Time) ([]OpenTx, error) { return s.open, nil }
func (s *fakeStore) LastBlock(context.Context) (Hash, int, bool, error) {
	return s.lastHash, s.lastH, s.haveBlock, nil
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

func hashOf(kind string, i int) Hash {
	return sha256d([]byte(kind), binary.LittleEndian.AppendUint64(nil, uint64(i)))
}

func outpoint(txid Hash, vout uint32) []byte {
	return binary.LittleEndian.AppendUint32(append([]byte(nil), txid[:]...), vout)
}

// mkTx makes a transaction spending the given outpoints.
func mkTx(name string, ins ...[]byte) *Tx {
	t := &Tx{Txid: hashOf(name, 0), Wtxid: hashOf(name, 1), Size: 200, Weight: 560}
	for _, o := range ins {
		t.Inputs = append(t.Inputs, o...)
	}
	return t
}

// coin is a confirmed outpoint nobody in the mempool spends yet.
func coin(i int) []byte { return outpoint(hashOf("coin", i), 0) }

type harness struct {
	t     *testing.T
	r     *Recorder
	node  *fakeNode
	ops   []Op
	raw   chan RawEvent
	clock int64
	zseq  uint32
	mseq  uint64
}

const hour = int64(3600 * 1_000_000)

func newHarness(t *testing.T, store Store) *harness {
	h := &harness{t: t, node: newFakeNode(), raw: make(chan RawEvent, 100), clock: 1_700_000_000_000_000}
	cfg := DefaultRecorderConfig()
	cfg.RawWait = 20 * time.Millisecond
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h.r = NewRecorder(cfg, h.node, store, func(op Op) { h.ops = append(h.ops, op) }, nil, h.raw, &Metrics{}, log)
	h.r.now = func() int64 { return h.clock }
	return h
}

func (h *harness) sync() {
	h.t.Helper()
	if err := h.r.Resync(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	if h.node.snapSeq > 0 {
		h.mseq = max(h.mseq, h.node.snapSeq-1) // the next event carries the snapshot's sequence
	}
}

func (h *harness) ev(kind byte, hash Hash) {
	h.clock += 1000
	h.zseq++
	e := SeqEvent{Kind: kind, Hash: hash, ZSeq: h.zseq, At: h.clock}
	if kind == 'A' || kind == 'R' {
		h.mseq++
		e.MSeq = h.mseq
	}
	h.r.HandleSeq(context.Background(), e)
}

// add publishes the rawtx (unless nil) and the A, like the node.
func (h *harness) add(tx *Tx) {
	h.r.HandleRaw(RawEvent{Tx: tx, ZSeq: h.zseq + 1000, At: h.clock})
	h.r.haveRaw = false
	h.ev('A', tx.Txid)
}

func (h *harness) quiet() {
	h.clock += 5_000_000
	h.r.Tick(context.Background())
}

func (h *harness) removal(txid Hash) *Removal {
	h.t.Helper()
	var found *Removal
	for _, op := range h.ops {
		if op.Remove != nil && op.Remove.Txid == txid {
			if found != nil {
				h.t.Fatalf("%s removed twice", txid)
			}
			found = op.Remove
		}
	}
	if found == nil {
		h.t.Fatalf("no removal for %s", txid)
	}
	return found
}

func (h *harness) noRemoval(txid Hash) {
	h.t.Helper()
	for _, op := range h.ops {
		if op.Remove != nil && op.Remove.Txid == txid {
			h.t.Fatalf("%s unexpectedly removed (%s)", txid, op.Remove.Reason)
		}
	}
}

func (h *harness) inserts(txid Hash) []*TxRow {
	var out []*TxRow
	for _, op := range h.ops {
		if op.Insert != nil && op.Insert.Txid == txid {
			out = append(out, op.Insert)
		}
	}
	return out
}

func (h *harness) blockRow(hash Hash, event string) *BlockRow {
	h.t.Helper()
	for _, op := range h.ops {
		if op.Block != nil && op.Block.Hash == hash && op.Block.Event == event {
			return op.Block
		}
	}
	h.t.Fatalf("no %s row for block %s", event, hash)
	return nil
}

func wantReason(t *testing.T, rm *Removal, reason string, by *Hash) {
	t.Helper()
	if rm.Reason != reason {
		t.Fatalf("%s: reason %s, want %s", rm.Txid, rm.Reason, reason)
	}
	if by != nil && (rm.By == nil || *rm.By != *by) {
		t.Fatalf("%s: replaced_by %v, want %s", rm.Txid, rm.By, by)
	}
}

func entry(tx *Tx, timeSec int64) MempoolEntry {
	return MempoolEntry{Txid: tx.Txid, Wtxid: tx.Wtxid, VSize: tx.VSize(), Weight: tx.Weight, Time: timeSec,
		Fee: 1000, ModFee: 1000, AncestorCount: 1, DescendantCount: 1}
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Subscribe, snapshot at sequence N, then apply only the buffered events above N.
func TestSyncRaceBufferedEvents(t *testing.T) {
	h := newHarness(t, nil)
	x, y := mkTx("x", coin(1)), mkTx("y", coin(2))
	h.node.snap, h.node.snapSeq = []MempoolEntry{entry(x, 1_700_000_000)}, 10
	h.node.raw[x.Txid] = x
	h.sync()
	if rows := h.inserts(x.Txid); len(rows) != 1 || rows[0].FirstSeenSrc != srcMempool || rows[0].Entry == nil ||
		rows[0].FirstSeen != 1_700_000_000_000_000 || rows[0].Size != 200 || len(rows[0].Inputs) != OutpointLen {
		t.Fatalf("snapshot row: %+v", rows)
	}
	// Buffered before the snapshot: x's own A (sequence 9, below the snapshot's 10) is already in it.
	h.r.HandleSeq(context.Background(), SeqEvent{Kind: 'A', Hash: x.Txid, MSeq: 9, ZSeq: 1, At: h.clock})
	h.zseq = 1
	if len(h.inserts(x.Txid)) != 1 || h.r.M.Stale.Load() != 1 {
		t.Fatal("event below the snapshot sequence was applied")
	}
	h.mseq = 9 // y's A carries 10: the first event the snapshot doesn't reflect
	h.add(y)
	if rows := h.inserts(y.Txid); len(rows) != 1 || rows[0].FirstSeenSrc != srcZMQ || !rows[0].NeedFees {
		t.Fatalf("buffered A after the snapshot: %+v", rows)
	}
	if len(h.r.txs) != 2 {
		t.Fatalf("tracked %d, want 2", len(h.r.txs))
	}
}

func TestReplacementAndDescendants(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	p1 := mkTx("p1", coin(1))
	c1 := mkTx("c1", outpoint(p1.Txid, 0)) // child of p1
	other := mkTx("other", coin(9))
	h.add(p1)
	h.add(c1)
	h.add(other)
	// RBF: Core removes the conflicts (and their descendants), then publishes the replacement's A.
	p2 := mkTx("p2", coin(1), coin(3))
	h.ev('R', p1.Txid)
	h.ev('R', c1.Txid)
	h.add(p2)
	h.quiet()
	by := p2.Txid
	wantReason(t, h.removal(p1.Txid), reasonReplaced, &by)
	wantReason(t, h.removal(c1.Txid), reasonReplaced, &by)
	h.noRemoval(other.Txid)
	// The replacement's inputs are now indexed: a second replacement of p2 is detected too.
	p3 := mkTx("p3", coin(3))
	h.ev('R', p2.Txid)
	h.add(p3)
	h.quiet()
	by = p3.Txid
	wantReason(t, h.removal(p2.Txid), reasonReplaced, &by)
}

// Package RBF: conflicts removed, then several As (the replacing tx may be the second one).
func TestPackageReplacement(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	old := mkTx("old", coin(1))
	h.add(old)
	parent := mkTx("parent", coin(2))
	child := mkTx("child", outpoint(parent.Txid, 0), coin(1))
	h.ev('R', old.Txid)
	h.add(parent)
	h.add(child)
	h.quiet()
	by := child.Txid
	wantReason(t, h.removal(old.Txid), reasonReplaced, &by)
}

func TestMinedAndOffMempool(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	a, b := mkTx("a", coin(1)), mkTx("b", coin(2))
	private := mkTx("private", coin(3))
	h.add(a)
	h.add(b)
	blk := h.node.addBlock(100, private, a)
	h.ev('C', blk)
	rm := h.removal(a.Txid)
	if rm.Reason != reasonMined || rm.Block == nil || *rm.Block != blk || rm.Height != 100 || rm.Src != srcZMQ {
		t.Fatalf("mined removal %+v", rm)
	}
	h.noRemoval(b.Txid)
	row := h.blockRow(blk, "connect")
	if !row.Checked || row.FromMempool != 1 || row.TxCount != 3 || len(row.Candidates) != 1 ||
		row.Candidates[0].Txid != private.Txid || row.Candidates[0].Position != 1 {
		t.Fatalf("block row %+v", row)
	}
	if _, ok := h.r.txs[a.Txid]; ok {
		t.Fatal("mined tx still tracked")
	}
}

func TestBlockConflict(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	victim := mkTx("victim", coin(5))
	desc := mkTx("desc", outpoint(victim.Txid, 1))
	h.add(victim)
	h.add(desc)
	// The block spends coin 5 with another tx: Core removes the conflicts (R), then publishes C.
	double := mkTx("double", coin(5))
	blk := h.node.addBlock(101, double)
	h.ev('R', victim.Txid)
	h.ev('R', desc.Txid)
	h.ev('C', blk)
	h.quiet()
	by := double.Txid
	rm := h.removal(victim.Txid)
	wantReason(t, rm, reasonConflict, &by)
	if rm.Block == nil || *rm.Block != blk || rm.Height != 101 {
		t.Fatalf("conflict block %+v", rm)
	}
	wantReason(t, h.removal(desc.Txid), reasonConflict, &by)
	if c := h.blockRow(blk, "connect").Candidates; len(c) != 1 || c[0].Txid != double.Txid {
		t.Fatalf("the conflicting block tx is off-mempool: %+v", c)
	}
}

func TestExpiredEvictedUnknown(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	old, young := mkTx("old", coin(1)), mkTx("young", coin(3))
	oldChild := mkTx("oldchild", outpoint(old.Txid, 0))
	h.add(old)
	h.clock += 335 * hour
	h.add(oldChild)
	h.add(young)
	h.clock += 2 * hour
	// Expiry removes the old tx and its (young) descendant.
	h.ev('R', old.Txid)
	h.ev('R', oldChild.Txid)
	h.quiet()
	wantReason(t, h.removal(old.Txid), reasonExpired, nil)
	wantReason(t, h.removal(oldChild.Txid), reasonExpired, nil)
	// Not full: unknown. Full (min fee raised above the relay minimum): evicted.
	h.ev('R', young.Txid)
	h.quiet()
	wantReason(t, h.removal(young.Txid), reasonUnknown, nil)
	z := mkTx("z", coin(4))
	h.add(z)
	h.node.info.MempoolMinFee = "0.00002" // the node starts trimming; our cached info (just fetched) predates it
	h.ev('R', z.Txid)
	h.quiet()
	wantReason(t, h.removal(z.Txid), reasonEvicted, nil)
	// An R for a tx we never saw added (trimmed right after acceptance) is counted, not recorded.
	h.ev('R', hashOf("never", 0))
	h.quiet()
	if h.r.M.UnknownRemovals.Load() != 1 {
		t.Fatal("unknown removal not counted")
	}
}

// Expiry/trimming of a previous accept runs before the next tx's A (Core 32 order: replaced, expired, trimmed, A):
// those removals must not be taken for replacements.
func TestTrimBeforeAIsNotReplacement(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	low := mkTx("low", coin(1))
	h.add(low)
	h.node.info.MempoolMinFee = "0.00005"
	h.ev('R', low.Txid)
	h.add(mkTx("newcomer", coin(2)))
	h.quiet()
	wantReason(t, h.removal(low.Txid), reasonEvicted, nil)
}

func TestReorg(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	a, keep := mkTx("a", coin(1)), mkTx("keep", coin(2))
	immature := mkTx("immature", coin(7))
	h.add(a)
	h.add(keep)
	h.add(immature)
	b1 := h.node.addBlock(200, a)
	h.ev('C', b1)
	wantReason(t, h.removal(a.Txid), reasonMined, nil)
	// Reorg: D, the block's txs come back (new A), invalid ones are removed (R, reason REORG), then the new C.
	h.ev('D', b1)
	if row := h.blockRow(b1, "disconnect"); row.Height != 200 {
		t.Fatalf("disconnect row %+v", row)
	}
	h.add(a)
	h.ev('R', immature.Txid)
	b1b := hashOf("block-b", 200)
	h.node.blocks[b1b] = &Block{Hash: b1b, Txs: []*Tx{{Txid: hashOf("cb", 9), Inputs: make([]byte, 36)}}}
	h.node.heights[b1b], h.node.byHeight[200] = 200, b1b
	h.ev('C', b1b)
	h.quiet()
	if rows := h.inserts(a.Txid); len(rows) != 2 || rows[1].FirstSeen <= rows[0].FirstSeen {
		t.Fatalf("re-added tx should get a new row: %d rows", len(rows))
	}
	wantReason(t, h.removal(immature.Txid), reasonReorg, nil)
	h.noRemoval(keep.Txid)
	if _, ok := h.r.txs[a.Txid]; !ok {
		t.Fatal("re-added tx not tracked")
	}
}

func TestGapTriggersResync(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	a, b := mkTx("a", coin(1)), mkTx("b", coin(2))
	h.add(a)
	h.zseq += 5 // ZMQ dropped messages (b's A among them)
	h.node.snap = []MempoolEntry{entry(a, h.clock/1_000_000), entry(b, h.clock/1_000_000)}
	h.node.snapSeq = h.mseq + 2 // reflects b's lost A (h.mseq+1), not c's (h.mseq+2)
	h.node.raw[b.Txid] = b
	c := mkTx("c", coin(3))
	h.mseq++ // b's A, lost
	h.add(c) // arrives after the gap
	if h.r.synced || h.r.held == nil || h.r.M.Gaps.Get("sequence") != 1 {
		t.Fatal("gap not detected")
	}
	h.sync()
	h.r.HandleSeq(context.Background(), *h.r.held)
	if len(h.inserts(a.Txid)) != 1 {
		t.Fatal("a (already tracked) must keep its row")
	}
	if rows := h.inserts(b.Txid); len(rows) != 1 || rows[0].FirstSeenSrc != srcMempool {
		t.Fatalf("b (missed) must come from the snapshot: %+v", rows)
	}
	if len(h.inserts(c.Txid)) != 1 || len(h.r.txs) != 3 {
		t.Fatalf("held event not applied after the resync (tracked %d)", len(h.r.txs))
	}
	if h.r.M.Resyncs.Get("gap") != 1 {
		t.Fatal("resync not counted")
	}
}

func TestRestartFromStore(t *testing.T) {
	kept, gone, unknownGone, readded, fresh := mkTx("kept", coin(1)), mkTx("gone", coin(2)), mkTx("ug", coin(3)),
		mkTx("readded", coin(4)), mkTx("fresh", coin(5))
	t0 := int64(1_700_000_000_000_000)
	store := &fakeStore{open: []OpenTx{
		{Txid: kept.Txid, FirstSeen: t0, Inputs: kept.Inputs},
		{Txid: gone.Txid, FirstSeen: t0, Inputs: gone.Inputs},
		{Txid: unknownGone.Txid, FirstSeen: t0},
		{Txid: readded.Txid, FirstSeen: t0},
	}}
	h := newHarness(t, store)
	last := h.node.addBlock(300)
	store.lastHash, store.lastH, store.haveBlock = last, 300, true
	minedAt := h.node.addBlock(301, gone) // mined while the recorder was down
	h.node.snap = []MempoolEntry{entry(kept, t0/1_000_000), entry(readded, t0/1_000_000+3600), entry(fresh, t0/1_000_000+10)}
	h.node.snapSeq = 50
	h.node.raw[fresh.Txid], h.node.raw[readded.Txid] = fresh, readded
	h.sync()
	if len(h.inserts(kept.Txid)) != 0 {
		t.Fatal("kept tx re-inserted")
	}
	rm := h.removal(gone.Txid)
	if rm.Reason != reasonMined || rm.Src != srcResync || rm.Block == nil || *rm.Block != minedAt || rm.Height != 301 {
		t.Fatalf("gone: %+v", rm)
	}
	if rm := h.removal(unknownGone.Txid); rm.Reason != reasonUnknown || rm.Src != srcResync {
		t.Fatalf("unknown gone: %+v", rm)
	}
	// Node entry time an hour after our row: it left and came back. Old row closed, new row.
	if rm := h.removal(readded.Txid); rm.Reason != reasonUnknown || rm.FirstSeen != t0 {
		t.Fatalf("re-added: %+v", rm)
	}
	if rows := h.inserts(readded.Txid); len(rows) != 1 || rows[0].FirstSeen != t0+3600*1_000_000 {
		t.Fatalf("re-added rows %+v", rows)
	}
	if rows := h.inserts(fresh.Txid); len(rows) != 1 || len(rows[0].Inputs) != OutpointLen {
		t.Fatalf("fresh rows %+v", rows)
	}
	if st := h.r.txs[readded.Txid]; len(st.inputs) != OutpointLen {
		t.Fatal("inputs of a re-added tx not fetched")
	}
	if h.r.lastMSq != 49 || !h.r.synced || h.r.tipHeight != 301 {
		t.Fatalf("state after sync: seq %d synced %v tip %d", h.r.lastMSq, h.r.synced, h.r.tipHeight)
	}
}

func TestLateRawFillsInputs(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	a := mkTx("a", coin(1))
	h.ev('A', a.Txid) // no rawtx yet
	row := h.inserts(a.Txid)[0]
	if !row.NeedRaw || row.HaveWtxid {
		t.Fatalf("row without rawtx: %+v", row)
	}
	h.r.HandleRaw(RawEvent{Tx: a, ZSeq: 1, At: h.clock})
	if st := h.r.txs[a.Txid]; len(st.inputs) != OutpointLen {
		t.Fatal("late rawtx didn't fill the inputs")
	}
	b := mkTx("b", coin(1))
	h.ev('R', a.Txid)
	h.add(b)
	h.quiet()
	by := b.Txid
	wantReason(t, h.removal(a.Txid), reasonReplaced, &by)
}

// rawtx arriving on its socket while the A waits for it.
func TestRawWait(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	a := mkTx("a", coin(1))
	go func() {
		time.Sleep(5 * time.Millisecond)
		h.raw <- RawEvent{Tx: a, ZSeq: 1}
	}()
	h.ev('A', a.Txid)
	if row := h.inserts(a.Txid)[0]; row.NeedRaw || len(row.Inputs) != OutpointLen {
		t.Fatalf("A didn't wait for its rawtx: %+v", row)
	}
}

func TestDriftTriggersResync(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	h.node.info.Size = 1000
	for range 3 {
		h.clock += 31_000_000
		h.r.Tick(context.Background())
	}
	if h.r.synced || h.r.resyncCause != "drift" {
		t.Fatal("drift didn't trigger a resync")
	}
}

func TestBlockFetchFailureResyncs(t *testing.T) {
	h := newHarness(t, nil)
	h.sync()
	a := mkTx("a", coin(1))
	h.add(a)
	blk := h.node.addBlock(10, a)
	h.node.failBlock = true
	h.ev('C', blk)
	if h.r.synced {
		t.Fatal("a block that can't be fetched must trigger a resync")
	}
	h.node.failBlock = false
	h.node.snap, h.node.snapSeq = nil, h.mseq
	h.r.tipHash, h.r.tipHeight, h.r.haveTip = hashOf("block", 9), 9, true
	h.node.heights[hashOf("block", 9)], h.node.byHeight[9] = 9, hashOf("block", 9)
	h.node.blocks[hashOf("block", 9)] = &Block{Hash: hashOf("block", 9), Txs: []*Tx{{Txid: hashOf("cb", 9)}}}
	h.sync()
	if rm := h.removal(a.Txid); rm.Reason != reasonMined || rm.Src != srcResync {
		t.Fatalf("catch-up classification: %+v", rm)
	}
}

func TestDecodeSequence(t *testing.T) {
	txid, _ := ParseDisplayHash("4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b")
	disp := make([]byte, 32)
	for i := range disp {
		disp[i] = txid[31-i]
	}
	body := append(append(append([]byte(nil), disp...), 'A'), binary.LittleEndian.AppendUint64(nil, 77)...)
	ev, err := decodeSequence(body, []byte{5, 0, 0, 0}, 1)
	if err != nil || ev.Kind != 'A' || ev.Hash != txid || ev.MSeq != 77 || ev.ZSeq != 5 {
		t.Fatalf("%+v %v", ev, err)
	}
	if _, err := decodeSequence(append(append([]byte(nil), disp...), 'C'), []byte{1, 0, 0, 0}, 1); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{body[:40], append(append([]byte(nil), disp...), 'X'), append(append([]byte(nil), disp...), 'C', 0)} {
		if _, err := decodeSequence(bad, []byte{1, 0, 0, 0}, 1); err == nil {
			t.Errorf("accepted %x", bad)
		}
	}
	if _, err := decodeSequence(body, []byte{1, 0}, 1); err == nil {
		t.Error("short counter accepted")
	}
}

func TestBtcToSats(t *testing.T) {
	for in, want := range map[string]int64{"0.00001": 1000, "1": 100_000_000, "0.12345678": 12_345_678, "21000000.00000000": 2_100_000_000_000_000, "-0.5": -50_000_000} {
		if got, err := btcToSats(json.Number(in)); err != nil || got != want {
			t.Errorf("%s: %d %v, want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "0.000000001", "abc"} {
		if _, err := btcToSats(json.Number(bad)); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
