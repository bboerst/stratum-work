package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeYAML(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "router.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

const validYAML = `
site: vps
targets:
  - id: foundry
    pool: Foundry USA
    upstream: work-foundry:3333
    targetThs: 10
  - id: antpool
    pool: AntPool
    upstream: work-antpool:3333
    targetThs: 5.5
remainder:
  id: ocean
  upstream: mine.ocean.xyz:3334
  username: bc1qexample
  password: x
`

func TestLoadAppliesDefaults(t *testing.T) {
	c, err := Load(writeYAML(t, validYAML))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Site != "vps" {
		t.Errorf("Site=%q", c.Site)
	}
	if len(c.Targets) != 2 || c.Targets[0].ID != "foundry" || c.Targets[1].TargetThs != 5.5 ||
		c.Targets[0].Pool != "Foundry USA" || c.Targets[0].Upstream != "work-foundry:3333" {
		t.Errorf("Targets=%+v", c.Targets)
	}
	if c.Remainder.ID != "ocean" || c.Remainder.Username != "bc1qexample" || c.Remainder.Password != "x" {
		t.Errorf("Remainder=%+v", c.Remainder)
	}
	checks := []struct {
		name      string
		got, want any
	}{
		{"Listen", c.Listen, ":3333"},
		{"AdminListen", c.AdminListen, ":9100"},
		{"MinSliceMs", c.Slice.MinSliceMs, 2000},
		{"MaxConnectionsPerIP", c.Limits.MaxConnectionsPerIP, 4},
		{"MaxConnections", c.Limits.MaxConnections, 500},
		{"InvalidShareBanRatio", c.Limits.InvalidShareBanRatio, 0.2},
		{"IdleTimeoutS", c.Limits.IdleTimeoutS, 300},
		{"VarDiff.Start", c.VarDiff.Start, 4096.0},
		{"VarDiff.Min", c.VarDiff.Min, 64.0},
		{"VarDiff.Max", c.VarDiff.Max, 1e9},
		{"VarDiff.SharesPerSec", c.VarDiff.SharesPerSec, 5.0},
		{"ThanksMinWorkMinutes", c.ThanksMinWorkMinutes, 60},
	}
	for _, ch := range checks {
		if ch.got != ch.want {
			t.Errorf("%s = %v, want %v", ch.name, ch.got, ch.want)
		}
	}
}

func TestLoadKeepsExplicitValues(t *testing.T) {
	c, err := Load(writeYAML(t, validYAML+`
listen: ":4444"
slice:
  minSliceMs: 500
limits:
  maxConnections: 1000
vardiff:
  start: 1024
  sharesPerSec: 2
thanksMinWorkMinutes: 30
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Listen != ":4444" || c.Slice.MinSliceMs != 500 || c.Limits.MaxConnections != 1000 ||
		c.VarDiff.Start != 1024 || c.VarDiff.SharesPerSec != 2 || c.ThanksMinWorkMinutes != 30 {
		t.Errorf("explicit values overridden: %+v", c)
	}
	if c.Limits.MaxConnectionsPerIP != 4 || c.VarDiff.Min != 64 {
		t.Errorf("unset siblings not defaulted: %+v", c)
	}
}

func TestLoadRemainderOnly(t *testing.T) {
	_, err := Load(writeYAML(t, `
remainder:
  id: ocean
  upstream: mine.ocean.xyz:3334
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func TestLoadFallbackOptionalAndValidated(t *testing.T) {
	_, err := Load(writeYAML(t, validYAML+`
fallbackRemainder:
  id: braiins
  upstream: stratum.braiins.com:3333
`))
	if err != nil {
		t.Fatalf("Load with fallback: %v", err)
	}
	_, err = Load(writeYAML(t, validYAML+`
fallbackRemainder:
  id: foundry
  upstream: stratum.braiins.com:3333
`))
	if err == nil {
		t.Fatal("expected duplicate id error between fallback and target")
	}
}

func TestLoadValidationErrors(t *testing.T) {
	cases := map[string]string{
		"duplicate target ids": `
targets:
  - {id: a, upstream: "h:1", targetThs: 1}
  - {id: a, upstream: "h:2", targetThs: 1}
remainder: {id: r, upstream: "h:3"}
`,
		"target id equals remainder id": `
targets:
  - {id: r, upstream: "h:1", targetThs: 1}
remainder: {id: r, upstream: "h:3"}
`,
		"targetThs zero": `
targets:
  - {id: a, upstream: "h:1", targetThs: 0}
remainder: {id: r, upstream: "h:3"}
`,
		"targetThs negative": `
targets:
  - {id: a, upstream: "h:1", targetThs: -1}
remainder: {id: r, upstream: "h:3"}
`,
		"upstream missing port": `
targets:
  - {id: a, upstream: "hostonly", targetThs: 1}
remainder: {id: r, upstream: "h:3"}
`,
		"upstream empty host": `
targets:
  - {id: a, upstream: ":3333", targetThs: 1}
remainder: {id: r, upstream: "h:3"}
`,
		"upstream empty port": `
remainder: {id: r, upstream: "h:"}
`,
		"target upstream empty": `
targets:
  - {id: a, targetThs: 1}
remainder: {id: r, upstream: "h:3"}
`,
		"target id empty": `
targets:
  - {upstream: "h:1", targetThs: 1}
remainder: {id: r, upstream: "h:3"}
`,
		"remainder id missing": `
targets:
  - {id: a, upstream: "h:1", targetThs: 1}
remainder: {upstream: "h:3"}
`,
		"remainder upstream missing": `
targets:
  - {id: a, upstream: "h:1", targetThs: 1}
remainder: {id: r}
`,
		"nothing configured": `
site: x
`,
		"bad fallback upstream": `
remainder: {id: r, upstream: "h:3"}
fallbackRemainder: {id: f, upstream: "nope"}
`,
		"malformed yaml": `
targets: [
`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(writeYAML(t, body)); err == nil {
				t.Fatalf("expected error")
			}
		})
	}
}

func TestLoadMissingFile(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestErrorsNeverContainPassword(t *testing.T) {
	const secret = "sup3r-s3cret-pw"
	bodies := []string{
		`
remainder: {id: r, upstream: "bad", username: u, password: "` + secret + `"}
`,
		`
remainder: {id: r, username: u, password: "` + secret + `"}
`,
		`
targets:
  - {id: r, upstream: "h:1", targetThs: 1}
remainder: {id: r, upstream: "h:3", password: "` + secret + `"}
fallbackRemainder: {id: r, upstream: "x", password: "` + secret + `"}
`,
	}
	for i, b := range bodies {
		_, err := Load(writeYAML(t, b))
		if err == nil {
			t.Fatalf("case %d: expected error", i)
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("case %d: error leaks password: %v", i, err)
		}
	}
}
