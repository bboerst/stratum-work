package router

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/bboerst/stratum-work/router/internal/stratum"
)

const maxWorkerLen = 64

func sanitizeWorker(u string) string {
	b := make([]byte, 0, len(u))
	for i := 0; i < len(u) && len(b) < maxWorkerLen; i++ {
		c := u[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
			b = append(b, c)
		}
	}
	if len(b) == 0 {
		return "anon"
	}
	return string(b)
}

func (s *session) onConfigure(m *stratum.Message) {
	var params []json.RawMessage
	_ = json.Unmarshal(m.Params, &params)
	var exts []string
	opts := map[string]any{}
	if len(params) > 0 {
		_ = json.Unmarshal(params[0], &exts)
	}
	if len(params) > 1 {
		_ = json.Unmarshal(params[1], &opts)
	}
	res := map[string]any{}
	for _, e := range exts {
		switch e {
		case "version-rolling":
			req := rollMask
			if v, ok := opts["version-rolling.mask"].(string); ok {
				if n, err := strconv.ParseUint(v, 16, 32); err == nil {
					req = uint32(n)
				}
			}
			mask := req & rollMask
			s.mu.Lock()
			s.mask = mask
			s.mu.Unlock()
			res["version-rolling"] = true
			res["version-rolling.mask"] = fmt.Sprintf("%08x", mask)
		case "minimum-difficulty":
			res["minimum-difficulty"] = false
		}
	}
	_ = s.c.Write(stratum.Response(m.ID, res, nil))
}

func (s *session) onAuthorize(m *stratum.Message) {
	var params []string
	_ = json.Unmarshal(m.Params, &params)
	user := ""
	if len(params) > 0 {
		user = params[0]
	}
	s.mu.Lock()
	s.worker = sanitizeWorker(user)
	s.authorized = true
	s.mu.Unlock()
	_ = s.c.Write(stratum.Response(m.ID, true, nil))
	s.sendWork(true)
}
