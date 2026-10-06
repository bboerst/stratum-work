package router

import (
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/bboerst/stratum-work/router/internal/config"
)

// Router accepts downstream miners and time-slices their work across targets.
type Router struct {
	cfg   *config.Config
	token string
	pub   Publisher
	log   *slog.Logger
	reg   *Registry

	targets   []*target // configured targets, remainder last
	remainder *target

	fallbackAfter time.Duration

	mu             sync.Mutex
	ln             net.Listener
	sessions       map[uint64]*session
	perIP          map[string]int
	bans           map[string]time.Time
	nextConn       uint64
	nextJob        uint64
	remDownSince   time.Time
	remUpSince     time.Time
	fallbackActive bool
	shares         map[string]uint64
	upSubmits      map[string]map[string]uint64
	workers        map[string]*workerAcct
}
