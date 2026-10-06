package router

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/bboerst/stratum-work/router/internal/stratum"
	"github.com/bboerst/stratum-work/router/internal/work"
)

const fixtureMask = 0x1fffe000

// fakePool is a minimal Stratum V1 pool that independently validates shares.
type fakePool struct {
	t      *testing.T
	ln     net.Listener
	en1    string
	diff   float64
	noRoll bool // refuse version rolling (mining.configure error)

	mu        sync.Mutex
	conns     []*stratum.Conn
	jobs      map[string]work.Job
	latest    work.Job
	seq       int
	accepted  int
	rejected  int
	usernames []string
}

func newFakePool(t *testing.T, en1 string, diff float64) *fakePool {
	t.Helper()
	return newFakePoolOpts(t, en1, diff, false)
}

func newFakePoolOpts(t *testing.T, en1 string, diff float64, noRoll bool) *fakePool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &fakePool{t: t, ln: ln, en1: en1, diff: diff, noRoll: noRoll, jobs: map[string]work.Job{}}
	p.mu.Lock()
	p.latest = p.makeJobLocked(true)
	p.mu.Unlock()
	t.Cleanup(p.close)
	go p.accept()
	return p
}

func (p *fakePool) Addr() string { return p.ln.Addr().String() }

func (p *fakePool) close() {
	_ = p.ln.Close()
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.conns {
		_ = c.Close()
	}
}

func (p *fakePool) makeJobLocked(clean bool) work.Job {
	p.seq++
	j := work.Job{
		UpstreamID: fmt.Sprintf("%s-%d", p.en1, p.seq),
		PrevHash:   fmt.Sprintf("%064x", 0xabc000+p.seq),
		Coinb1:     "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20" + fmt.Sprintf("%08x", p.seq),
		Coinb2:     "ffffffff0100f2052a010000001976a914000000000000000000000000000000000000000088ac00000000",
		Branches:   []string{fmt.Sprintf("%064x", 0x1111+p.seq), fmt.Sprintf("%064x", 0x2222+p.seq)},
		Version:    0x20000000,
		NBits:      "1d00ffff",
		NTime:      fmt.Sprintf("%08x", time.Now().Unix()),
		Clean:      clean,
	}
	p.jobs[j.UpstreamID] = j
	return j
}

func notifyMsg(j work.Job) map[string]any {
	return stratum.Notify("mining.notify", j.UpstreamID, j.PrevHash, j.Coinb1, j.Coinb2,
		j.Branches, fmt.Sprintf("%08x", j.Version), j.NBits, j.NTime, j.Clean)
}

// PushJob broadcasts a new job; clean=true invalidates previous jobs.
func (p *fakePool) PushJob(clean bool) work.Job {
	p.mu.Lock()
	if clean {
		p.jobs = map[string]work.Job{}
	}
	j := p.makeJobLocked(clean)
	p.latest = j
	conns := append([]*stratum.Conn(nil), p.conns...)
	p.mu.Unlock()
	for _, c := range conns {
		_ = c.Write(notifyMsg(j))
	}
	return j
}

func (p *fakePool) Accepted() int { p.mu.Lock(); defer p.mu.Unlock(); return p.accepted }
func (p *fakePool) Rejected() int { p.mu.Lock(); defer p.mu.Unlock(); return p.rejected }
func (p *fakePool) Usernames() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.usernames...)
}

func (p *fakePool) accept() {
	for {
		raw, err := p.ln.Accept()
		if err != nil {
			return
		}
		c := stratum.NewConn(raw)
		p.mu.Lock()
		p.conns = append(p.conns, c)
		p.mu.Unlock()
		go p.serve(c)
	}
}

func (p *fakePool) serve(c *stratum.Conn) {
	defer c.Close()
	var mask uint32
	for {
		m, err := c.Read()
		if err != nil {
			return
		}
		var params []json.RawMessage
		_ = json.Unmarshal(m.Params, &params)
		switch m.Method {
		case "mining.configure":
			if p.noRoll {
				_ = c.Write(stratum.Response(m.ID, nil, stratum.ErrOther))
				continue
			}
			mask = fixtureMask
			_ = c.Write(stratum.Response(m.ID, map[string]any{
				"version-rolling": true, "version-rolling.mask": fmt.Sprintf("%08x", mask)}, nil))
		case "mining.subscribe":
			_ = c.Write(stratum.Response(m.ID, []any{
				[]any{[]any{"mining.set_difficulty", "s"}, []any{"mining.notify", "s"}}, p.en1, 8}, nil))
		case "mining.authorize":
			var user string
			if len(params) > 0 {
				_ = json.Unmarshal(params[0], &user)
			}
			p.mu.Lock()
			p.usernames = append(p.usernames, user)
			j := p.latest
			p.mu.Unlock()
			_ = c.Write(stratum.Response(m.ID, true, nil))
			_ = c.Write(stratum.Notify("mining.set_difficulty", p.diff))
			_ = c.Write(notifyMsg(j))
		case "mining.submit":
			ok := p.validate(params, mask)
			p.mu.Lock()
			if ok {
				p.accepted++
			} else {
				p.rejected++
			}
			p.mu.Unlock()
			if ok {
				_ = c.Write(stratum.Response(m.ID, true, nil))
			} else {
				_ = c.Write(stratum.Response(m.ID, false, stratum.ErrLowDiff))
			}
		}
	}
}

// validate rebuilds coinb1||en1||en2||coinb2 and checks the header hash.
func (p *fakePool) validate(params []json.RawMessage, mask uint32) bool {
	if len(params) < 5 {
		return false
	}
	s := make([]string, len(params))
	for i := range params {
		if json.Unmarshal(params[i], &s[i]) != nil {
			return false
		}
	}
	p.mu.Lock()
	j, ok := p.jobs[s[1]]
	p.mu.Unlock()
	if !ok || len(s[2]) != 16 {
		return false
	}
	version := j.Version
	if len(s) > 5 {
		var vb uint32
		if _, err := fmt.Sscanf(s[5], "%08x", &vb); err != nil || vb&^mask != 0 {
			return false
		}
		version = work.RolledVersion(j.Version, vb, mask)
	}
	cb, err := work.BuildCoinbase(j.Coinb1, p.en1, s[2], j.Coinb2)
	if err != nil {
		return false
	}
	root, err := work.MerkleRoot(cb, j.Branches)
	if err != nil {
		return false
	}
	h, err := work.BuildHeader(version, j.PrevHash, root, s[3], j.NBits, s[4])
	if err != nil {
		return false
	}
	return work.MeetsTarget(work.DoubleSHA256(h[:]), work.DiffToTarget(p.diff))
}

// minerJob is a downstream job as seen by the miner.
type minerJob struct {
	ID, PrevHash, Coinb1, Coinb2, NBits, NTime string
	Branches                                   []string
	Version                                    uint32
	Clean                                      bool
}

// cpuMiner is a real (slow) Stratum miner that hashes jobs from the router.
type cpuMiner struct {
	t    *testing.T
	c    *stratum.Conn
	stop chan struct{}
	done chan struct{}

	mu        sync.Mutex
	en1       string
	en2Size   int
	mask      uint32
	diff      float64
	job       *minerJob
	jobGen    int
	cleanSeen int
	results   map[int]int // 0 = accepted, else stratum error code
	pending   map[uint64]bool
	nextID    uint64
	en2Ctr    uint64
	gotSub    chan struct{}
}

func dialMiner(t *testing.T, addr string) *cpuMiner {
	t.Helper()
	raw, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	m := &cpuMiner{t: t, c: stratum.NewConn(raw), stop: make(chan struct{}), done: make(chan struct{}),
		results: map[int]int{}, pending: map[uint64]bool{}, nextID: 100, gotSub: make(chan struct{})}
	t.Cleanup(m.Stop)
	go m.readLoop()
	_ = m.c.Write(stratum.Request(1, "mining.configure", []string{"version-rolling"},
		map[string]any{"version-rolling.mask": "1fffe000", "version-rolling.min-bit-count": 2}))
	_ = m.c.Write(stratum.Request(2, "mining.subscribe", "cpuminer-test/1"))
	_ = m.c.Write(stratum.Request(3, "mining.authorize", "tester", "x"))
	select {
	case <-m.gotSub:
	case <-time.After(3 * time.Second):
		t.Fatal("miner: no subscribe response")
	}
	return m
}

// Stop halts hashing and closes the connection (idempotent).
func (m *cpuMiner) Stop() {
	m.mu.Lock()
	select {
	case <-m.stop:
		m.mu.Unlock()
		return
	default:
		close(m.stop)
	}
	m.mu.Unlock()
	_ = m.c.Close()
}

func errCode(m *stratum.Message) int {
	if len(m.Error) == 0 || string(m.Error) == "null" {
		var ok bool
		if json.Unmarshal(m.Result, &ok) == nil && ok {
			return 0
		}
		return 20
	}
	var arr []any
	if json.Unmarshal(m.Error, &arr) == nil && len(arr) > 0 {
		if f, ok := arr[0].(float64); ok {
			return int(f)
		}
	}
	return 20
}

func (m *cpuMiner) readLoop() {
	defer close(m.done)
	for {
		msg, err := m.c.Read()
		if err != nil {
			return
		}
		var params []json.RawMessage
		_ = json.Unmarshal(msg.Params, &params)
		switch msg.Method {
		case "mining.set_difficulty":
			var d float64
			if len(params) > 0 && json.Unmarshal(params[0], &d) == nil {
				m.mu.Lock()
				m.diff = d
				m.mu.Unlock()
			}
			continue
		case "mining.notify":
			if len(params) < 9 {
				continue
			}
			var j minerJob
			var ver string
			for i, dst := range []*string{&j.ID, &j.PrevHash, &j.Coinb1, &j.Coinb2} {
				_ = json.Unmarshal(params[i], dst)
			}
			_ = json.Unmarshal(params[4], &j.Branches)
			_ = json.Unmarshal(params[5], &ver)
			_ = json.Unmarshal(params[6], &j.NBits)
			_ = json.Unmarshal(params[7], &j.NTime)
			_ = json.Unmarshal(params[8], &j.Clean)
			_, _ = fmt.Sscanf(ver, "%08x", &j.Version)
			m.mu.Lock()
			m.job = &j
			m.jobGen++
			if j.Clean {
				m.cleanSeen++
			}
			m.mu.Unlock()
			continue
		case "":
		default:
			continue
		}
		var id uint64
		if json.Unmarshal(msg.ID, &id) != nil {
			continue
		}
		switch id {
		case 1:
			var res map[string]any
			if json.Unmarshal(msg.Result, &res) == nil {
				if s, ok := res["version-rolling.mask"].(string); ok {
					var mask uint32
					_, _ = fmt.Sscanf(s, "%08x", &mask)
					m.mu.Lock()
					m.mask = mask
					m.mu.Unlock()
				}
			}
		case 2:
			var res []json.RawMessage
			if json.Unmarshal(msg.Result, &res) == nil && len(res) >= 3 {
				m.mu.Lock()
				_ = json.Unmarshal(res[1], &m.en1)
				_ = json.Unmarshal(res[2], &m.en2Size)
				m.mu.Unlock()
			}
			close(m.gotSub)
		case 3:
		default:
			code := errCode(msg)
			m.mu.Lock()
			if m.pending[id] {
				delete(m.pending, id)
				m.results[code]++
			}
			m.mu.Unlock()
		}
	}
}

// Diff, CleanSeen, Results, WaitJob are thread-safe accessors.
func (m *cpuMiner) Diff() float64  { m.mu.Lock(); defer m.mu.Unlock(); return m.diff }
func (m *cpuMiner) CleanSeen() int { m.mu.Lock(); defer m.mu.Unlock(); return m.cleanSeen }
func (m *cpuMiner) En1() string    { m.mu.Lock(); defer m.mu.Unlock(); return m.en1 }
func (m *cpuMiner) Result(code int) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.results[code]
}
func (m *cpuMiner) Job() (minerJob, int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.job == nil {
		return minerJob{}, m.jobGen, false
	}
	return *m.job, m.jobGen, true
}

// WaitJob waits until a job with generation > afterGen arrives.
func (m *cpuMiner) WaitJob(afterGen int, timeout time.Duration) (minerJob, int) {
	m.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if j, g, ok := m.Job(); ok && g > afterGen {
			return j, g
		}
		time.Sleep(5 * time.Millisecond)
	}
	m.t.Fatalf("miner: no job after gen %d within %v", afterGen, timeout)
	return minerJob{}, 0
}

type share struct{ JobID, En2, NTime, Nonce, VersionBits string }

// hashShare computes the header hash exactly like a miner.
func (m *cpuMiner) hashShare(j minerJob, en1, en2 string, nonce uint32, vbits uint32, mask uint32) ([32]byte, error) {
	cb, err := work.BuildCoinbase(j.Coinb1, en1, en2, j.Coinb2)
	if err != nil {
		return [32]byte{}, err
	}
	root, err := work.MerkleRoot(cb, j.Branches)
	if err != nil {
		return [32]byte{}, err
	}
	h, err := work.BuildHeader(work.RolledVersion(j.Version, vbits, mask), j.PrevHash, root, j.NTime, j.NBits, fmt.Sprintf("%08x", nonce))
	if err != nil {
		return [32]byte{}, err
	}
	return work.DoubleSHA256(h[:]), nil
}

// FindShare searches en2/nonce space for a share meeting the current
// downstream difficulty on job j. Returns false if gen changed (abort) or stopped.
func (m *cpuMiner) FindShare(j minerJob, gen int) (share, bool) {
	m.mu.Lock()
	en1, size, mask, diff := m.en1, m.en2Size, m.mask, m.diff
	m.mu.Unlock()
	if diff <= 0 || size <= 0 {
		return share{}, false
	}
	target := work.DiffToTarget(diff)
	vbits := uint32(0x00002000) & mask
	for {
		m.mu.Lock()
		m.en2Ctr++
		ctr := m.en2Ctr
		m.mu.Unlock()
		en2 := fmt.Sprintf("%0*x", size*2, ctr)
		if len(en2) > size*2 {
			en2 = en2[len(en2)-size*2:]
		}
		for nonce := uint32(0); nonce < 1<<20; nonce++ {
			if nonce&0xff == 0 {
				select {
				case <-m.stop:
					return share{}, false
				default:
				}
				if gen >= 0 {
					if _, g, _ := m.Job(); g != gen {
						return share{}, false
					}
				}
			}
			h, err := m.hashShare(j, en1, en2, nonce, vbits, mask)
			if err != nil {
				m.t.Errorf("miner: bad job: %v", err)
				return share{}, false
			}
			if work.MeetsTarget(h, target) {
				vb := ""
				if mask != 0 {
					vb = fmt.Sprintf("%08x", vbits)
				}
				return share{j.ID, en2, j.NTime, fmt.Sprintf("%08x", nonce), vb}, true
			}
		}
	}
}

// Submit sends a share; the response is tallied into Result(code).
func (m *cpuMiner) Submit(s share) {
	m.mu.Lock()
	m.nextID++
	id := m.nextID
	m.pending[id] = true
	m.mu.Unlock()
	params := []any{"tester", s.JobID, s.En2, s.NTime, s.Nonce}
	if s.VersionBits != "" {
		params = append(params, s.VersionBits)
	}
	_ = m.c.Write(stratum.Request(id, "mining.submit", params...))
}

// WaitResult waits until Result(code) >= n.
func (m *cpuMiner) WaitResult(code, n int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if m.Result(code) >= n {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

// Mine hashes continuously on the latest job until Stop.
func (m *cpuMiner) Mine() {
	go func() {
		for {
			select {
			case <-m.stop:
				return
			default:
			}
			j, gen, ok := m.Job()
			if !ok {
				time.Sleep(5 * time.Millisecond)
				continue
			}
			if s, ok := m.FindShare(j, gen); ok {
				m.Submit(s)
			}
		}
	}()
}
