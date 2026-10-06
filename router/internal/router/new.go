package router

import (
	"log/slog"
	"time"

	"github.com/bboerst/stratum-work/router/internal/accounting"
	"github.com/bboerst/stratum-work/router/internal/config"
	"github.com/bboerst/stratum-work/router/internal/upstream"
)

type workerAcct struct {
	rate  *accounting.Rate
	since time.Time
	last  time.Time
}

// New builds a router. token authenticates to work collectors (targets).
func New(cfg *config.Config, token string, pub Publisher, log *slog.Logger) *Router {
	if log == nil {
		log = slog.Default()
	}
	r := &Router{
		cfg: cfg, token: token, pub: pub, log: log, reg: NewRegistry(),
		fallbackAfter: 10 * time.Second,
		sessions:      map[uint64]*session{},
		perIP:         map[string]int{},
		bans:          map[string]time.Time{},
		shares:        map[string]uint64{},
		upSubmits:     map[string]map[string]uint64{},
		workers:       map[string]*workerAcct{},
	}
	for _, tc := range cfg.Targets {
		t := &target{id: tc.ID, pool: tc.Pool, targetHs: tc.TargetThs * 1e12,
			delivered: accounting.NewRate(rateTau)}
		t.client = upstream.New(tc.ID, tc.Upstream, cfg.Site, token, r, log)
		r.targets = append(r.targets, t)
	}
	rem := &target{id: cfg.Remainder.ID, pool: "DATUM", remainder: true,
		delivered: accounting.NewRate(rateTau)}
	rem.client = upstream.New(cfg.Remainder.ID, cfg.Remainder.Upstream,
		cfg.Remainder.Username, cfg.Remainder.Password, r, log)
	if cfg.Fallback.Upstream != "" {
		rem.fallback = upstream.New(cfg.Remainder.ID, cfg.Fallback.Upstream,
			cfg.Fallback.Username, cfg.Fallback.Password, &fallbackEvents{r}, log)
	}
	r.remainder = rem
	r.targets = append(r.targets, rem)
	return r
}

func (r *Router) target(id string) *target {
	for _, t := range r.targets {
		if t.id == id {
			return t
		}
	}
	return nil
}
