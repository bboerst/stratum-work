package main

import (
	"bytes"
	"errors"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Python-compatible JSON. The Python collector decodes every line with json.loads and publishes json.dumps(document)
// to RabbitMQ; its Postgres sink converts the decoded values with Python semantics (str(), int(), bool(),
// bytes.fromhex()). To produce byte-identical messages and rows, the Go collector keeps each value as Python would
// see it (pyValue) instead of Go's encoding/json types:
//   - integers keep every digit (Python ints are unbounded), floats are float64 and print like Python's repr();
//   - strings may hold lone surrogates (json.loads accepts "\ud800"); they are kept as WTF-8 (the surrogate encoded
//     like any other code point) so they can be re-escaped exactly;
//   - objects keep key order, and a repeated key keeps its first position with the last value (Python dict);
//   - NaN, Infinity and -Infinity literals are accepted, like json.loads.
// pyDumps reproduces json.dumps defaults: ensure_ascii, separators ", " and ": ", allow_nan.

type pyKind uint8

const (
	pyNull pyKind = iota
	pyFalse
	pyTrue
	pyInt   // s = canonical decimal digits (optional leading '-')
	pyFloat // f
	pyStr   // s = WTF-8
	pyList  // items
	pyDict  // keys + items
)

type pyValue struct {
	kind  pyKind
	s     string
	f     float64
	keys  []string
	items []pyValue
}

func pyString(s string) pyValue { return pyValue{kind: pyStr, s: s} }
func pyIntOf(i int64) pyValue   { return pyValue{kind: pyInt, s: strconv.FormatInt(i, 10)} }
func pyFloatOf(f float64) pyValue {
	return pyValue{kind: pyFloat, f: f}
}

// get returns the value for key in a dict (Python dict.get).
func (v pyValue) get(key string) (pyValue, bool) {
	if v.kind != pyDict {
		return pyValue{}, false
	}
	for i, k := range v.keys {
		if k == key {
			return v.items[i], true
		}
	}
	return pyValue{}, false
}

// truthy is Python bool(value).
func (v pyValue) truthy() bool {
	switch v.kind {
	case pyNull, pyFalse:
		return false
	case pyTrue:
		return true
	case pyInt:
		return v.s != "0"
	case pyFloat:
		return v.f != 0 // NaN is truthy in Python too
	case pyStr:
		return v.s != ""
	case pyList, pyDict:
		return len(v.items) > 0
	}
	return false
}

// ── decoding (json.loads) ────────────────────────────────────────────────────────────────────────────────────────

var errPyJSON = errors.New("invalid JSON")

// pyLoads decodes one JSON document the way json.loads(bytes) does for UTF-8 input (a UTF-8 BOM is skipped;
// encoded surrogates are accepted, like Python's 'surrogatepass'). UTF-16/32 input, which json.loads would detect
// from NUL bytes, is rejected.
func pyLoads(b []byte) (pyValue, error) {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if !validWTF8(b) {
		return pyValue{}, errPyJSON
	}
	d := pyDecoder{b: b}
	d.ws()
	v, err := d.value()
	if err != nil {
		return pyValue{}, err
	}
	d.ws()
	if d.i != len(d.b) {
		return pyValue{}, errPyJSON // "Extra data"
	}
	return v, nil
}

type pyDecoder struct {
	b []byte
	i int
}

func (d *pyDecoder) ws() {
	for d.i < len(d.b) {
		switch d.b[d.i] {
		case ' ', '\t', '\n', '\r':
			d.i++
		default:
			return
		}
	}
}

func (d *pyDecoder) lit(s string) bool {
	if bytes.HasPrefix(d.b[d.i:], []byte(s)) {
		d.i += len(s)
		return true
	}
	return false
}

func (d *pyDecoder) value() (pyValue, error) {
	if d.i >= len(d.b) {
		return pyValue{}, errPyJSON
	}
	switch c := d.b[d.i]; {
	case c == '"':
		s, err := d.str()
		return pyString(s), err
	case c == '{':
		return d.object()
	case c == '[':
		return d.array()
	case c == 'n' && d.lit("null"):
		return pyValue{kind: pyNull}, nil
	case c == 't' && d.lit("true"):
		return pyValue{kind: pyTrue}, nil
	case c == 'f' && d.lit("false"):
		return pyValue{kind: pyFalse}, nil
	case c == 'N' && d.lit("NaN"):
		return pyFloatOf(math.NaN()), nil
	case c == 'I' && d.lit("Infinity"):
		return pyFloatOf(math.Inf(1)), nil
	case c == '-' && d.lit("-Infinity"):
		return pyFloatOf(math.Inf(-1)), nil
	case c == '-' || (c >= '0' && c <= '9'):
		return d.number()
	}
	return pyValue{}, errPyJSON
}

// number follows Python's NUMBER_RE: (-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?
func (d *pyDecoder) number() (pyValue, error) {
	start := d.i
	if d.b[d.i] == '-' {
		d.i++
	}
	digits := func() int {
		n := 0
		for d.i < len(d.b) && d.b[d.i] >= '0' && d.b[d.i] <= '9' {
			d.i++
			n++
		}
		return n
	}
	if d.i < len(d.b) && d.b[d.i] == '0' {
		d.i++
	} else if digits() == 0 {
		return pyValue{}, errPyJSON
	}
	isFloat := false
	if d.i+1 < len(d.b) && d.b[d.i] == '.' && d.b[d.i+1] >= '0' && d.b[d.i+1] <= '9' {
		d.i++
		digits()
		isFloat = true
	}
	if d.i < len(d.b) && (d.b[d.i] == 'e' || d.b[d.i] == 'E') {
		save := d.i
		d.i++
		if d.i < len(d.b) && (d.b[d.i] == '+' || d.b[d.i] == '-') {
			d.i++
		}
		if digits() == 0 {
			d.i = save // not part of the number (then "extra data" fails the parse, as in Python)
		} else {
			isFloat = true
		}
	}
	lit := string(d.b[start:d.i])
	if isFloat {
		f, err := strconv.ParseFloat(lit, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) { // out of range: ±inf or 0, like Python's float()
			return pyValue{}, errPyJSON
		}
		return pyFloatOf(f), nil
	}
	n, ok := new(big.Int).SetString(lit, 10)
	if !ok {
		return pyValue{}, errPyJSON
	}
	return pyValue{kind: pyInt, s: n.String()}, nil
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func (d *pyDecoder) hex4() (rune, bool) {
	if d.i+4 > len(d.b) {
		return 0, false
	}
	var r rune
	for k := 0; k < 4; k++ {
		h := hexVal(d.b[d.i+k])
		if h < 0 {
			return 0, false
		}
		r = r<<4 | rune(h)
	}
	d.i += 4
	return r, true
}

// str decodes a JSON string (strict=True: raw control characters are errors). Returns WTF-8.
func (d *pyDecoder) str() (string, error) {
	d.i++ // opening quote
	var sb strings.Builder
	for {
		if d.i >= len(d.b) {
			return "", errPyJSON
		}
		c := d.b[d.i]
		switch {
		case c == '"':
			d.i++
			return sb.String(), nil
		case c < 0x20:
			return "", errPyJSON
		case c != '\\':
			sb.WriteByte(c)
			d.i++
			continue
		}
		d.i++
		if d.i >= len(d.b) {
			return "", errPyJSON
		}
		e := d.b[d.i]
		d.i++
		switch e {
		case '"', '\\', '/':
			sb.WriteByte(e)
		case 'b':
			sb.WriteByte('\b')
		case 'f':
			sb.WriteByte('\f')
		case 'n':
			sb.WriteByte('\n')
		case 'r':
			sb.WriteByte('\r')
		case 't':
			sb.WriteByte('\t')
		case 'u':
			r, ok := d.hex4()
			if !ok {
				return "", errPyJSON
			}
			if r >= 0xd800 && r <= 0xdbff && d.i+6 <= len(d.b) && d.b[d.i] == '\\' && d.b[d.i+1] == 'u' {
				save := d.i
				d.i += 2
				if r2, ok := d.hex4(); ok && r2 >= 0xdc00 && r2 <= 0xdfff {
					r = 0x10000 + (r-0xd800)<<10 + (r2 - 0xdc00)
				} else {
					d.i = save
				}
			}
			writeWTF8(&sb, r)
		default:
			return "", errPyJSON
		}
	}
}

func (d *pyDecoder) array() (pyValue, error) {
	d.i++
	v := pyValue{kind: pyList, items: []pyValue{}}
	d.ws()
	if d.i < len(d.b) && d.b[d.i] == ']' {
		d.i++
		return v, nil
	}
	for {
		d.ws()
		item, err := d.value()
		if err != nil {
			return pyValue{}, err
		}
		v.items = append(v.items, item)
		d.ws()
		if d.i >= len(d.b) {
			return pyValue{}, errPyJSON
		}
		switch d.b[d.i] {
		case ',':
			d.i++
		case ']':
			d.i++
			return v, nil
		default:
			return pyValue{}, errPyJSON
		}
	}
}

func (d *pyDecoder) object() (pyValue, error) {
	d.i++
	v := pyValue{kind: pyDict, keys: []string{}, items: []pyValue{}}
	d.ws()
	if d.i < len(d.b) && d.b[d.i] == '}' {
		d.i++
		return v, nil
	}
	for {
		d.ws()
		if d.i >= len(d.b) || d.b[d.i] != '"' {
			return pyValue{}, errPyJSON
		}
		k, err := d.str()
		if err != nil {
			return pyValue{}, err
		}
		d.ws()
		if d.i >= len(d.b) || d.b[d.i] != ':' {
			return pyValue{}, errPyJSON
		}
		d.i++
		d.ws()
		item, err := d.value()
		if err != nil {
			return pyValue{}, err
		}
		replaced := false
		for j, existing := range v.keys {
			if existing == k {
				v.items[j] = item // dict semantics: first position, last value
				replaced = true
				break
			}
		}
		if !replaced {
			v.keys = append(v.keys, k)
			v.items = append(v.items, item)
		}
		d.ws()
		if d.i >= len(d.b) {
			return pyValue{}, errPyJSON
		}
		switch d.b[d.i] {
		case ',':
			d.i++
		case '}':
			d.i++
			return v, nil
		default:
			return pyValue{}, errPyJSON
		}
	}
}

// ── WTF-8 (UTF-8 that may also contain encoded surrogates) ─────────────────────────────────────────────────────

func writeWTF8(sb *strings.Builder, r rune) {
	if r >= 0xd800 && r <= 0xdfff {
		sb.WriteByte(byte(0xe0 | r>>12))
		sb.WriteByte(byte(0x80 | (r>>6)&0x3f))
		sb.WriteByte(byte(0x80 | r&0x3f))
		return
	}
	sb.WriteRune(r)
}

// decodeWTF8 decodes one code point (surrogates included). size 0 = invalid.
func decodeWTF8(s string, i int) (rune, int) {
	if i+3 <= len(s) && s[i] == 0xed && s[i+1] >= 0xa0 && s[i+1] <= 0xbf && s[i+2]&0xc0 == 0x80 {
		return rune(s[i]&0x0f)<<12 | rune(s[i+1]&0x3f)<<6 | rune(s[i+2]&0x3f), 3
	}
	r, n := utf8.DecodeRuneInString(s[i:])
	if r == utf8.RuneError && n <= 1 {
		return 0, 0
	}
	return r, n
}

func validWTF8(b []byte) bool {
	s := string(b)
	for i := 0; i < len(s); {
		if s[i] < 0x80 {
			i++
			continue
		}
		_, n := decodeWTF8(s, i)
		if n == 0 {
			return false
		}
		i += n
	}
	return true
}

// hasSurrogate reports whether s holds a lone surrogate (not encodable as UTF-8, e.g. for Postgres text).
func hasSurrogate(s string) bool {
	for i := 0; i < len(s); {
		r, n := decodeWTF8(s, i)
		if n == 0 {
			return true
		}
		if r >= 0xd800 && r <= 0xdfff {
			return true
		}
		i += n
	}
	return false
}

// ── encoding (json.dumps defaults) ───────────────────────────────────────────────────────────────────────────────

func pyDumps(v pyValue) []byte {
	var b bytes.Buffer
	pyEncode(&b, v)
	return b.Bytes()
}

func pyEncode(b *bytes.Buffer, v pyValue) {
	switch v.kind {
	case pyNull:
		b.WriteString("null")
	case pyFalse:
		b.WriteString("false")
	case pyTrue:
		b.WriteString("true")
	case pyInt:
		b.WriteString(v.s)
	case pyFloat:
		b.WriteString(pyFloatJSON(v.f))
	case pyStr:
		pyEncodeString(b, v.s)
	case pyList:
		b.WriteByte('[')
		for i, it := range v.items {
			if i > 0 {
				b.WriteString(", ")
			}
			pyEncode(b, it)
		}
		b.WriteByte(']')
	case pyDict:
		b.WriteByte('{')
		for i, k := range v.keys {
			if i > 0 {
				b.WriteString(", ")
			}
			pyEncodeString(b, k)
			b.WriteString(": ")
			pyEncode(b, v.items[i])
		}
		b.WriteByte('}')
	}
}

const lowerHex = "0123456789abcdef"

func writeU4(b *bytes.Buffer, r rune) {
	b.WriteString(`\u`)
	b.WriteByte(lowerHex[r>>12&0xf])
	b.WriteByte(lowerHex[r>>8&0xf])
	b.WriteByte(lowerHex[r>>4&0xf])
	b.WriteByte(lowerHex[r&0xf])
}

// pyEncodeString is Python's encode_basestring_ascii: everything outside printable ASCII is escaped.
func pyEncodeString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < 0x80 {
			switch c {
			case '\\':
				b.WriteString(`\\`)
			case '"':
				b.WriteString(`\"`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if c < 0x20 || c == 0x7f {
					writeU4(b, rune(c))
				} else {
					b.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, n := decodeWTF8(s, i)
		if n == 0 { // cannot happen for decoded input; be defensive
			r, n = utf8.RuneError, 1
		}
		if r >= 0x10000 {
			v := r - 0x10000
			writeU4(b, 0xd800|(v>>10)&0x3ff)
			writeU4(b, 0xdc00|v&0x3ff)
		} else {
			writeU4(b, r)
		}
		i += n
	}
	b.WriteByte('"')
}

// pyFloatJSON is json.dumps for a float: NaN / Infinity / -Infinity, otherwise float.__repr__.
func pyFloatJSON(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	return pyFloatRepr(f)
}

// pyFloatRepr is Python's repr(float) (also str(float)): the shortest round-tripping digits, in fixed notation when
// the decimal exponent is in (-4, 16], else in scientific notation with a signed exponent of at least two digits.
func pyFloatRepr(f float64) string {
	switch {
	case math.IsNaN(f):
		return "nan"
	case math.IsInf(f, 1):
		return "inf"
	case math.IsInf(f, -1):
		return "-inf"
	}
	sign := ""
	if math.Signbit(f) {
		sign = "-"
		f = -f
	}
	if f == 0 {
		return sign + "0.0"
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddddde±XX
	mant, expStr, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expStr)
	decpt := exp + 1 // value = 0.digits × 10^decpt
	if decpt > -4 && decpt <= 16 {
		switch {
		case decpt <= 0:
			return sign + "0." + strings.Repeat("0", -decpt) + digits
		case decpt >= len(digits):
			return sign + digits + strings.Repeat("0", decpt-len(digits)) + ".0"
		default:
			return sign + digits[:decpt] + "." + digits[decpt:]
		}
	}
	m := digits[:1]
	if len(digits) > 1 {
		m += "." + digits[1:]
	}
	es := "+"
	x := decpt - 1
	if x < 0 {
		es = "-"
		x = -x
	}
	xs := strconv.Itoa(x)
	if len(xs) < 2 {
		xs = "0" + xs
	}
	return sign + m + "e" + es + xs
}

// ── Python conversions used by the Postgres sink (pgsink.py to_row) ──────────────────────────────────────────────

var errPyType = errors.New("TypeError")

// pyStr is Python str(value) for a decoded JSON value.
func pyStrOf(v pyValue) string {
	switch v.kind {
	case pyStr:
		return v.s
	case pyNull:
		return "None"
	case pyTrue:
		return "True"
	case pyFalse:
		return "False"
	case pyInt:
		return v.s
	case pyFloat:
		return pyFloatRepr(v.f)
	}
	return pyRepr(v)
}

// pyRepr is Python repr() for a decoded JSON value (lists and dicts; strings with Python's quoting rules).
func pyRepr(v pyValue) string {
	switch v.kind {
	case pyStr:
		return pyReprString(v.s)
	case pyList:
		parts := make([]string, len(v.items))
		for i, it := range v.items {
			parts[i] = pyRepr(it)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case pyDict:
		parts := make([]string, len(v.keys))
		for i, k := range v.keys {
			parts[i] = pyReprString(k) + ": " + pyRepr(v.items[i])
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return pyStrOf(v)
}

// pyReprString approximates Python's str.__repr__ (printability uses Go's unicode tables, which can differ from
// Python's for rare code points; only reachable for list/dict job ids).
func pyReprString(s string) string {
	quote := byte('\'')
	if strings.IndexByte(s, '\'') >= 0 && strings.IndexByte(s, '"') < 0 {
		quote = '"'
	}
	var b strings.Builder
	b.WriteByte(quote)
	for i := 0; i < len(s); {
		r, n := decodeWTF8(s, i)
		if n == 0 {
			r, n = utf8.RuneError, 1
		}
		i += n
		switch {
		case r == rune(quote) || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r < 0x20 || r == 0x7f:
			b.WriteString(`\x`)
			b.WriteByte(lowerHex[r>>4])
			b.WriteByte(lowerHex[r&0xf])
		case r < 0x7f:
			b.WriteRune(r)
		case (r >= 0xd800 && r <= 0xdfff) || !unicode.IsPrint(r) || r == 0xa0 || r == 0xad:
			switch {
			case r <= 0xff:
				b.WriteString(`\x`)
				b.WriteByte(lowerHex[r>>4])
				b.WriteByte(lowerHex[r&0xf])
			case r <= 0xffff:
				b.WriteString(`\u`)
				b.WriteString(strings.Repeat("0", 4-len(strconv.FormatInt(int64(r), 16))) + strconv.FormatInt(int64(r), 16))
			default:
				h := strconv.FormatInt(int64(r), 16)
				b.WriteString(`\U` + strings.Repeat("0", 8-len(h)) + h)
			}
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte(quote)
	return b.String()
}

// isPySpace is Py_ISSPACE (ASCII whitespace, including \v and \f).
func isPySpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}

// pyFromHex is bytes.fromhex(value): ASCII whitespace between byte pairs is skipped; anything else must be pairs of
// hex digits. Non-strings raise TypeError.
func pyFromHex(v pyValue) ([]byte, error) {
	if v.kind != pyStr {
		return nil, errPyType
	}
	s := v.s
	out := make([]byte, 0, len(s)/2)
	for i := 0; i < len(s); {
		if isPySpace(s[i]) {
			i++
			continue
		}
		if i+1 >= len(s) {
			return nil, errors.New("non-hexadecimal number found in fromhex() arg")
		}
		hi, lo := hexVal(s[i]), hexVal(s[i+1])
		if hi < 0 || lo < 0 {
			return nil, errors.New("non-hexadecimal number found in fromhex() arg")
		}
		out = append(out, byte(hi<<4|lo))
		i += 2
	}
	return out, nil
}

// pyTransformDigits mirrors _PyUnicode_TransformDecimalAndSpaceToASCII, applied by int(str): Unicode whitespace
// becomes ' ', Unicode decimal digits become ASCII digits, other non-ASCII characters become '?' (invalid).
func pyTransformDigits(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		r, n := decodeWTF8(s, i)
		if n == 0 {
			r, n = '?', 1
		}
		i += n
		switch {
		case r < 0x80:
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteByte(' ')
		case unicode.Is(unicode.Nd, r):
			b.WriteByte(byte('0' + decimalValue(r)))
		default:
			b.WriteByte('?')
		}
	}
	return b.String()
}

func decimalValue(r rune) int {
	for _, rg := range unicode.Nd.R16 {
		if rune(rg.Lo) <= r && r <= rune(rg.Hi) && rg.Stride == 1 {
			return int(r-rune(rg.Lo)) % 10
		}
	}
	for _, rg := range unicode.Nd.R32 {
		if rune(rg.Lo) <= r && r <= rune(rg.Hi) && rg.Stride == 1 {
			return int(r-rune(rg.Lo)) % 10
		}
	}
	return 0
}

// pyIntParse is int(s, base) for base 10 or 16: surrounding whitespace, a sign, an optional 0x prefix (base 16),
// and single underscores between digits are accepted.
func pyIntParse(s string, base int) (*big.Int, error) {
	bad := errors.New("invalid literal for int()")
	s = pyTransformDigits(s)
	i, j := 0, len(s)
	for i < j && isPySpace(s[i]) {
		i++
	}
	for j > i && isPySpace(s[j-1]) {
		j--
	}
	t := s[i:j]
	neg := false
	if t != "" && (t[0] == '+' || t[0] == '-') {
		neg = t[0] == '-'
		t = t[1:]
	}
	prefixed := false
	if base == 16 && len(t) >= 2 && t[0] == '0' && (t[1] == 'x' || t[1] == 'X') {
		t = t[2:]
		prefixed = true
	}
	if prefixed && strings.HasPrefix(t, "_") {
		t = t[1:]
	}
	if t == "" || t[0] == '_' || t[len(t)-1] == '_' || strings.Contains(t, "__") {
		return nil, bad
	}
	t = strings.ReplaceAll(t, "_", "")
	for k := 0; k < len(t); k++ {
		h := hexVal(t[k])
		if h < 0 || h >= base {
			return nil, bad
		}
	}
	n, ok := new(big.Int).SetString(t, base)
	if !ok {
		return nil, bad
	}
	if neg {
		n.Neg(n)
	}
	return n, nil
}

// pyU32 is pgsink._u32: int(value, 16) bounded to 0..0xFFFFFFFF.
func pyU32(v pyValue) (int64, error) {
	if v.kind != pyStr {
		return 0, errPyType
	}
	n, err := pyIntParse(v.s, 16)
	if err != nil {
		return 0, err
	}
	if n.Sign() < 0 || n.Cmp(big.NewInt(0xFFFFFFFF)) > 0 {
		return 0, errors.New("not a 32-bit value")
	}
	return n.Int64(), nil
}

// pyIntOfValue is Python int(value) for a decoded JSON value.
func pyIntOfValue(v pyValue) (*big.Int, error) {
	switch v.kind {
	case pyInt:
		n, _ := new(big.Int).SetString(v.s, 10)
		return n, nil
	case pyTrue:
		return big.NewInt(1), nil
	case pyFalse:
		return big.NewInt(0), nil
	case pyFloat:
		if math.IsNaN(v.f) || math.IsInf(v.f, 0) {
			return nil, errors.New("cannot convert float to integer")
		}
		n, _ := big.NewFloat(math.Trunc(v.f)).Int(nil)
		return n, nil
	case pyStr:
		return pyIntParse(v.s, 10)
	}
	return nil, errPyType
}
