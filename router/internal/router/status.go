package router

import "time"

// Publisher receives periodic routing status (implemented in Task 8).
type Publisher interface {
	Publish(status any) error
}

type TargetStatus struct {
	ID, Pool              string
	TargetHs, DeliveredHs float64
	Available             bool
}

type RemainderStatus struct {
	ID             string
	DeliveredHs    float64
	FallbackActive bool
}

type WorkerStatus struct {
	Name        string
	Hs          float64
	Since       time.Time
	WorkSeconds float64
}

type ConnStatus struct {
	ID                                  uint64
	Worker                              string
	Hs, Diff                            float64
	Target                              string
	Accepted, Invalid, Stale, Duplicate uint64
}

type Counters struct {
	Shares          map[string]uint64            // accepted|invalid|stale|duplicate
	UpstreamSubmits map[string]map[string]uint64 // target -> accepted|rejected
}

type Status struct {
	Site        string
	TotalHs     float64
	Targets     []TargetStatus
	Remainder   RemainderStatus
	Workers     []WorkerStatus
	Connections []ConnStatus
	Counters    Counters
}
