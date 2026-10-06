package stratum

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"
)

const maxLine = 64 * 1024

type Message struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}

func (m *Message) IsRequest() bool      { return m.Method != "" && !isNull(m.ID) }
func (m *Message) IsNotification() bool { return m.Method != "" && isNull(m.ID) }
func isNull(r json.RawMessage) bool     { return len(r) == 0 || string(r) == "null" }

var (
	ErrJobNotFound   = []any{21, "Job not found", nil}
	ErrDuplicate     = []any{22, "Duplicate share", nil}
	ErrLowDiff       = []any{23, "Low difficulty share", nil}
	ErrUnauthorized  = []any{24, "Unauthorized worker", nil}
	ErrNotSubscribed = []any{25, "Not subscribed", nil}
	ErrOther         = []any{20, "Other/Unknown", nil}
)

type Conn struct {
	c  net.Conn
	r  *bufio.Reader
	mu sync.Mutex
}

func NewConn(c net.Conn) *Conn { return &Conn{c: c, r: bufio.NewReaderSize(c, 4096)} }

func (c *Conn) Read() (*Message, error) {
	var line []byte
	for {
		chunk, isPrefix, err := c.r.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) > maxLine {
			return nil, errors.New("stratum: line too long")
		}
		if !isPrefix {
			break
		}
	}
	var m Message
	if err := json.Unmarshal(line, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (c *Conn) Write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err = c.c.Write(append(b, '\n'))
	return err
}

func (c *Conn) Close() error { return c.c.Close() }

func (c *Conn) RemoteIP() string {
	if a, ok := c.c.RemoteAddr().(*net.TCPAddr); ok {
		return a.IP.String()
	}
	host, _, _ := net.SplitHostPort(c.c.RemoteAddr().String())
	return host
}

func Request(id any, method string, params ...any) map[string]any {
	if params == nil {
		params = []any{}
	}
	return map[string]any{"id": id, "method": method, "params": params}
}

func Response(id json.RawMessage, result any, err any) map[string]any {
	return map[string]any{"id": id, "result": result, "error": err}
}

func Notify(method string, params ...any) map[string]any {
	if params == nil {
		params = []any{}
	}
	return map[string]any{"id": nil, "method": method, "params": params}
}
