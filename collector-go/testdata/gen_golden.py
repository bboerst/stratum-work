"""Generate golden.json: what the Python collector produces for each test notification.

For every case, the raw line goes through the same Python code the collector runs: json.loads (as get_msg does on
bytes), create_notification_document (chain classification patched to the case's value, _id fixed), json.dumps
(the RabbitMQ body), pgsink.to_row and pgsink.route (the Postgres row). collector-go's golden_test.go feeds the same
lines through the Go pipeline and requires identical output.

Run from the repo root in a throwaway container (needs collector/requirements.txt):
  docker run --rm -v "$PWD:/repo" -w /repo python:3.13 sh -c \
    'pip install -q -r collector/requirements.txt && python collector-go/testdata/gen_golden.py > collector-go/testdata/golden.json'
"""
import base64
import json
import sys
from datetime import datetime
from unittest import mock

sys.path.insert(0, ".")
from collector.main import create_notification_document  # noqa: E402
from collector.pgsink import to_row, route  # noqa: E402

PREFIX = "01000000" + "01" + "00" * 32 + "ffffffff"
CB1 = PREFIX + "4b0393e20e" + "2f4d696e65642062792074657374" + "00" * 8   # height 975507
CB2 = "ffffffff02" + "00" * 20
PREV = "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"
BR = ["aa" * 32, "bb" * 32]
SUB = '{"id": 1, "result": [[["mining.set_difficulty", "1"], ["mining.notify", "1"]], "abcd1234", 8], "error": null}'
TS = 1_794_437_000_123_456_789


def notify(job='"j1"', prev=f'"{PREV}"', cb1=f'"{CB1}"', cb2=f'"{CB2}"', br=json.dumps(BR), ver='"20000000"',
           nbits='"1702e5b4"', ntime='"69d72a43"', clean="true"):
    return ('{"id": null, "method": "mining.notify", "params": [' +
            ", ".join([job, prev, cb1, cb2, br, ver, nbits, ntime, clean]) + "]}")


C = []


def case(name, line, sub=SUB, latency=(12.5, "tcp"), chain=None, tip=975_506, ts=TS, pool="TestPool"):
    if isinstance(line, str):
        line = line.encode()
    C.append(dict(name=name, line=line, sub=sub, latency=latency, chain=chain, tip=tip, ts=ts, pool=pool))


case("typical", notify())
case("chain bch", notify(), chain="bch")
case("chain unknown", notify(), chain="unknown")
case("no latency", notify(), latency=None)
case("no tip", notify(), tip=None)
case("implausible height", notify(), tip=975_400)
case("tip + 2", notify(), tip=975_505)
case("tip - 6", notify(), tip=975_513)
for i, lat in enumerate([0.0005, 1.0, 0.123456789, 1e-05, 5e-07, 12345678901234567.0, 1e16, 1234567890123456.0,
                         30.000000000000004, 0.1 + 0.2, 100.0, 2.5e-3]):
    case(f"latency float {i}", notify(), latency=(lat, "app" if i % 2 else "tcp"))
case("latency bogus method", notify(), latency=(3.0, "bogus"))
for i, job in enumerate(['12345', '1.5', '1e20', '1E400', '-0.0', 'true', 'false', 'null', '["a", 1]',
                         '{"k": "v", "k2": [1.0]}', '"j\\u00f6b-\\u2603-\\ud83d\\ude00"', '"c\\u0001\\u007f\\t"',
                         '"lone\\ud800x"', '"a\\/b\\"\\\\"', '"\\u00e9t\\u00e9"', '123456789012345678901234567890',
                         '-0', '"it\'s"', '"both\'\\""', '[1.5, null, true]', '"nul\\u0000x"']):
    case(f"job_id {i}", notify(job=job))
for i, v in enumerate(['"0x20000000"', '" 20000000 "', '"2000_0000"', '"-0"', '"+1"', '"1ffffffff"', '""',
                       '"1D00FFFF"', '"0X_1f"', '"_1f"', '"1f_"', '"1__f"', '"-1"', '536870912', 'null',
                       '"\\u0661\\u0662"', '"\\u00a0ff\\u2003"', '"0x"', '"ffffffff"', '" \\t\\n1f\\r "']):
    case(f"version {i}", notify(ver=v))
for i, v in enumerate(['" ab cd "', '"AB"', '"abc"', '123', '""', '"zz"', '"a b"', '"\\u000bab\\u000c"', 'null']):
    case(f"prev_hash {i}", notify(prev=v))
for i, v in enumerate(['[]', 'null', '"   "', '"a"', '{"aa": 1, "bb": 2}', '5', '0', '""', '[" aa ", "BB"]', '["a"]',
                       'false', '[1]']):
    case(f"merkle {i}", notify(br=v))
for i, v in enumerate(['""', '"0"', '0', '0.0', '[]', '{}', '"false"', 'NaN', '-0.0', '1', 'null', '[0]', 'Infinity']):
    case(f"clean_jobs {i}", notify(clean=v))
for i, r in enumerate(['["ab", 4.9]', '["ab", "8"]', '["ab", " 8 "]', '["ab", true]', '["ab", null]', '["ab", "x"]',
                       '["ABCD", 4]', '[1, 2, "", 0]', '["abcd", -1]', '["abcd", "1_0"]', '["abcd", 1e2]']):
    case(f"subscribe {i}", notify(), sub='{"id": 1, "result": ' + r + ', "error": null}')
case("no subscribe result", notify(), sub=None)
for i, v in enumerate(['123456789012345678901234567890', '-0', '1E400', '-0.0', '1.0', '1e5', '{"a": 1, "b": 2, "a": 3}',
                       '[[], {}, ""]', '1e-7', '-1E-400', '0.1', '1e16', '9007199254740993']):
    case(f"odd values {i}", notify(ntime='"69d72a43"', br=f'[{v}]' if False else json.dumps(BR), cb2=f'"{CB2}"',
                                   nbits='"1702e5b4"', job=v))
case("ts multiple of 1e6", notify(), ts=1_794_437_000_000_000_000)
case("ts sub-us", notify(), ts=1_794_437_000_123_456_999)
case("ts epoch", notify(), ts=1)
case("height parse fails", notify(cb1='"zz"'))
case("height parse fails, not str", notify(cb1='12'))
case("height 0 push", notify(cb1=f'"{PREFIX}0a0100aabbcc"'))
case("op_1 height", notify(cb1=f'"{PREFIX}0a51aabbcc"'), tip=None)
case("other chain height", notify(cb1=f'"{PREFIX}0a03cf726a00"'))   # 6976207
case("unicode pool", notify(), pool="Pööl ☃")
case("bom", b"\xef\xbb\xbf" + notify().encode())
case("trailing cr", notify() + "\r")
case("leading ws", "  \t" + notify())
case("trailing garbage", notify() + "x")
case("invalid utf8", notify(job='"\xff"').encode("latin-1"))
case("raw control char", notify(job='"a\x01b"'))
case("encoded surrogate", notify().replace('"j1"', '"') .encode()[:0] + b'{"id": null, "method": "mining.notify", "params": ["\xed\xa0\x80", "' + PREV.encode() + b'", "' + CB1.encode() + b'", "' + CB2.encode() + b'", [], "20000000", "1702e5b4", "69d72a43", true]}')
case("extra params", notify(clean='true, "extra", 7'))
case("nested dup keys", '{"method": "mining.notify", "id": 5, "params": ["j", "' + PREV + '", "' + CB1 + '", "' + CB2 + '", [], "20000000", "1702e5b4", "69d72a43", {"x": 1, "y": 2, "x": 3}], "method": "mining.notify"}')
case("1e999 number", notify(job='1e999'))
case("big exponent", notify(job='-1e999'))
case("tiny", notify(job='4.9e-324'))
case("float int-like", notify(job='100.0'))


def ser(v):
    if isinstance(v, datetime):
        return "ts:" + v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return "hex:" + v.hex()
    if isinstance(v, float):
        return "f:" + repr(v)
    return v


out = []
for c in C:
    rec = dict(name=c["name"], line=base64.b64encode(c["line"]).decode(), sub=c["sub"],
               latency=list(c["latency"]) if c["latency"] else None, chain=c["chain"], tip=c["tip"], ts=c["ts"],
               pool=c["pool"])
    try:
        msg = json.loads(c["line"])
    except Exception as e:  # get_msg skips the line
        rec["loads_error"] = type(e).__name__
        out.append(rec)
        continue
    en1, en2 = None, -1
    if c["sub"] is not None:
        r = json.loads(c["sub"].encode()).get("result")
        if r is not None:
            en1, en2 = r[-2:]
    with mock.patch("collector.main.classify_notification_chain", return_value=c["chain"]):
        doc = create_notification_document(msg, c["pool"], en1, en2, hex(c["ts"])[2:],
                                           latency=tuple(c["latency"]) if c["latency"] else None)
    doc["_id"] = "00000000-0000-4000-8000-000000000000"
    rec["json"] = json.dumps(doc)
    try:
        row = to_row(doc, 7)
        rec["row"] = json.dumps([ser(v) for v in row])
        r = route(row[2], doc.get("chain_family"), c["tip"])
        rec["route"] = [r.table, r.chain, r.reason]
    except (KeyError, ValueError, TypeError) as e:
        rec["row_error"] = type(e).__name__ + ": " + str(e)
    out.append(rec)

json.dump(out, sys.stdout, indent=1)
print()
