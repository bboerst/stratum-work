// Package config loads the router's YAML configuration, applies defaults and
// validates it. Secrets (WORK_TOKEN, AMQP_URL) come from the environment and
// are deliberately not part of Config.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Site        string `yaml:"site"`
	Listen      string `yaml:"listen"`
	AdminListen string `yaml:"adminListen"`
	Slice       struct {
		MinSliceMs int `yaml:"minSliceMs"`
	} `yaml:"slice"`
	Targets   []TargetConfig `yaml:"targets"`
	Remainder UpstreamConfig `yaml:"remainder"`
	Fallback  UpstreamConfig `yaml:"fallbackRemainder"`
	Limits    struct {
		MaxConnectionsPerIP  int     `yaml:"maxConnectionsPerIp"`
		MaxConnections       int     `yaml:"maxConnections"`
		InvalidShareBanRatio float64 `yaml:"invalidShareBanRatio"`
		IdleTimeoutS         int     `yaml:"idleTimeoutS"`
	} `yaml:"limits"`
	VarDiff struct {
		Start        float64 `yaml:"start"`
		Min          float64 `yaml:"min"`
		Max          float64 `yaml:"max"`
		SharesPerSec float64 `yaml:"sharesPerSec"`
	} `yaml:"vardiff"`
	ThanksMinWorkMinutes int `yaml:"thanksMinWorkMinutes"`
}

type TargetConfig struct {
	ID        string  `yaml:"id"`
	Pool      string  `yaml:"pool"`
	Upstream  string  `yaml:"upstream"`
	TargetThs float64 `yaml:"targetThs"`
}

type UpstreamConfig struct {
	ID       string `yaml:"id"`
	Upstream string `yaml:"upstream"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
}

// Load reads YAML from path, applies defaults and validates the result.
// Returned errors never include password values.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		// yaml.v3 errors reference line numbers and types, not scalar values.
		return nil, fmt.Errorf("parse config: %w", err)
	}
	applyDefaults(&cfg)
	if err := validate(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func applyDefaults(c *Config) {
	setStr(&c.Listen, ":3333")
	setStr(&c.AdminListen, ":9100")
	setInt(&c.Slice.MinSliceMs, 2000)
	setInt(&c.Limits.MaxConnectionsPerIP, 4)
	setInt(&c.Limits.MaxConnections, 500)
	setFloat(&c.Limits.InvalidShareBanRatio, 0.2)
	setInt(&c.Limits.IdleTimeoutS, 300)
	setFloat(&c.VarDiff.Start, 4096)
	setFloat(&c.VarDiff.Min, 64)
	setFloat(&c.VarDiff.Max, 1e9)
	setFloat(&c.VarDiff.SharesPerSec, 5)
	setInt(&c.ThanksMinWorkMinutes, 60)
}

func setStr(p *string, d string) {
	if *p == "" {
		*p = d
	}
}

func setInt(p *int, d int) {
	if *p == 0 {
		*p = d
	}
}

func setFloat(p *float64, d float64) {
	if *p == 0 {
		*p = d
	}
}

func validate(c *Config) error {
	if len(c.Targets) == 0 && c.Remainder.ID == "" && c.Remainder.Upstream == "" {
		return errors.New("config: no targets and no remainder configured")
	}

	ids := make(map[string]string) // id -> field that claimed it
	claim := func(id, field string) error {
		if id == "" {
			return fmt.Errorf("config: %s.id is required", field)
		}
		if prev, ok := ids[id]; ok {
			return fmt.Errorf("config: duplicate id %q (%s and %s)", id, prev, field)
		}
		ids[id] = field
		return nil
	}

	for i, t := range c.Targets {
		field := fmt.Sprintf("targets[%d]", i)
		if err := claim(t.ID, field); err != nil {
			return err
		}
		if !(t.TargetThs > 0) {
			return fmt.Errorf("config: %s (%s): targetThs must be > 0", field, t.ID)
		}
		if err := checkHostPort(t.Upstream, field+".upstream"); err != nil {
			return err
		}
	}

	if err := claim(c.Remainder.ID, "remainder"); err != nil {
		return err
	}
	if err := checkHostPort(c.Remainder.Upstream, "remainder.upstream"); err != nil {
		return err
	}

	if c.Fallback.Upstream != "" {
		if err := claim(c.Fallback.ID, "fallbackRemainder"); err != nil {
			return err
		}
		if err := checkHostPort(c.Fallback.Upstream, "fallbackRemainder.upstream"); err != nil {
			return err
		}
	}
	return nil
}

// checkHostPort requires a non-empty host:port. The address itself is included
// in the error (it is not a secret); passwords never reach this function.
func checkHostPort(addr, field string) error {
	if addr == "" {
		return fmt.Errorf("config: %s is required", field)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("config: %s %q must be host:port: %v", field, addr, err)
	}
	if host == "" || port == "" {
		return fmt.Errorf("config: %s %q must have non-empty host and port", field, addr)
	}
	return nil
}
