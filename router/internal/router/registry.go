package router

import (
	"sync"
	"time"

	"github.com/bboerst/stratum-work/router/internal/upstream"
	"github.com/bboerst/stratum-work/router/internal/work"
)

// maxEntriesPerTarget bounds how many downstream jobs are remembered per target.
const maxEntriesPerTarget = 64

// Entry is the state needed to validate and forward a share for a downstream job.
type Entry struct {
	Target  string
	Job     work.Job
	En1     string
	Fold    work.Fold
	Diff    float64 // session difficulty at send time
	Created time.Time
	Mask    uint32 // connection's negotiated version mask at send time, 0 = none

	client *upstream.Client // client that issued the job
}

type shareKey struct {
	en2, ntime, nonce string
	version           uint32
}

type regItem struct {
	entry Entry
	seen  map[shareKey]struct{}
}

// Registry maps downstream job ids to entries and tracks submitted shares for
// duplicate detection. Share memory lives and dies with its job.
type Registry struct {
	mu       sync.Mutex
	items    map[string]*regItem
	byTarget map[string][]string // downstream job ids, oldest first
}

func NewRegistry() *Registry {
	return &Registry{items: map[string]*regItem{}, byTarget: map[string][]string{}}
}

func (r *Registry) Put(downJobID string, e Entry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, ok := r.items[downJobID]; ok {
		r.removeFromOrder(old.entry.Target, downJobID)
	}
	r.items[downJobID] = &regItem{entry: e}
	ids := append(r.byTarget[e.Target], downJobID)
	for len(ids) > maxEntriesPerTarget {
		delete(r.items, ids[0])
		ids = ids[1:]
	}
	r.byTarget[e.Target] = ids
}

func (r *Registry) Get(downJobID string) (Entry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	it, ok := r.items[downJobID]
	if !ok {
		return Entry{}, false
	}
	return it.entry, true
}

// InvalidateTarget drops every entry (and its share memory) for target.
func (r *Registry) InvalidateTarget(target string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, id := range r.byTarget[target] {
		delete(r.items, id)
	}
	delete(r.byTarget, target)
}

// Seen records the share and reports whether it was already submitted for
// this job. Unknown jobs are not recorded and report false.
func (r *Registry) Seen(downJobID, en2, ntime, nonce string, version uint32) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	it, ok := r.items[downJobID]
	if !ok {
		return false
	}
	k := shareKey{en2, ntime, nonce, version}
	if _, dup := it.seen[k]; dup {
		return true
	}
	if it.seen == nil {
		it.seen = map[shareKey]struct{}{}
	}
	it.seen[k] = struct{}{}
	return false
}

func (r *Registry) removeFromOrder(target, id string) {
	ids := r.byTarget[target]
	for i, v := range ids {
		if v == id {
			r.byTarget[target] = append(ids[:i:i], ids[i+1:]...)
			return
		}
	}
}

// seenCount returns the number of remembered shares across all jobs (tests).
func (r *Registry) seenCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, it := range r.items {
		n += len(it.seen)
	}
	return n
}
