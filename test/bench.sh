#!/usr/bin/env bash
# Benchmark script for Gemini MCP bridge performance
# Usage: ./test/bench.sh [before|after]
set -euo pipefail

BRIDGE="$(cd "$(dirname "$0")/.." && pwd)/server/gemini/index.js"
LABEL="${1:-baseline}"
RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$RESULTS_DIR"
OUTFILE="$RESULTS_DIR/${LABEL}.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log() { printf "${GREEN}[bench]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[bench]${NC} %s\n" "$1"; }
err()  { printf "${RED}[bench]${NC} %s\n" "$1"; }

# Send a JSON-RPC request to the bridge and measure response time
# Returns: elapsed_ms and the response
send_rpc() {
  local request="$1"
  local timeout_s="${2:-30}"
  local start end elapsed response

  start=$(python3 -c 'import time; print(int(time.time()*1000))')
  response=$(printf '%s\n' "$request" | timeout "${timeout_s}" node "$BRIDGE" 2>/dev/null | head -1) || response='{"error":"timeout"}'
  end=$(python3 -c 'import time; print(int(time.time()*1000))')
  elapsed=$((end - start))

  echo "$elapsed|$response"
}

# --- Test 1: Bridge initialization (MCP handshake) ---
log "Test 1/4: MCP initialize handshake"
INIT_REQ='{"jsonrpc":"2.0","id":"t1","method":"initialize","params":{}}'
result=$(send_rpc "$INIT_REQ" 10)
init_ms="${result%%|*}"
init_resp="${result#*|}"

if echo "$init_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('result',{}).get('serverInfo')" 2>/dev/null; then
  log "  init: ${init_ms}ms - OK"
else
  err "  init: ${init_ms}ms - FAILED"
  init_ms=-1
fi

# --- Test 2: tools/list ---
log "Test 2/4: tools/list"
LIST_REQ='{"jsonrpc":"2.0","id":"t2","method":"tools/list","params":{}}'
result=$(send_rpc "$LIST_REQ" 10)
list_ms="${result%%|*}"
list_resp="${result#*|}"

tool_count=$(echo "$list_resp" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('tools',[])))" 2>/dev/null || echo 0)
log "  tools/list: ${list_ms}ms - ${tool_count} tools"

# --- Test 3: Simple gemini call (short prompt) ---
log "Test 3/4: Simple gemini call (short prompt)"
SIMPLE_REQ='{"jsonrpc":"2.0","id":"t3","method":"tools/call","params":{"name":"gemini","arguments":{"prompt":"Reply with exactly: PONG","model":"gemini-2.5-flash"}}}'
result=$(send_rpc "$SIMPLE_REQ" 60)
simple_ms="${result%%|*}"
simple_resp="${result#*|}"

has_content=$(echo "$simple_resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{})
c=r.get('content',[])
print('ok' if c and not r.get('isError') else 'err')
" 2>/dev/null || echo "err")

if [ "$has_content" = "ok" ]; then
  log "  simple call: ${simple_ms}ms - OK"
else
  warn "  simple call: ${simple_ms}ms - ERROR"
  simple_ms=-1
fi

# --- Test 4: Complex gemini call (large prompt) ---
log "Test 4/4: Complex gemini call (large prompt ~2KB)"
COMPLEX_PROMPT="Analyze this code for security issues and respond with a JSON object containing 'issues' array. Keep response under 200 words.\n\nconst express = require('express');\nconst app = express();\napp.use(express.json());\n\napp.post('/login', (req, res) => {\n  const { user, pass } = req.body;\n  const query = 'SELECT * FROM users WHERE user=\\'' + user + '\\' AND pass=\\'' + pass + '\\'';\n  db.query(query, (err, rows) => {\n    if (rows.length) { res.json({ token: jwt.sign({ user }, 'hardcoded-secret') }); }\n    else { res.status(401).json({ error: 'Invalid' }); }\n  });\n});\n\napp.get('/admin', (req, res) => {\n  const data = req.query.data;\n  res.send('<h1>' + data + '</h1>');\n});"

COMPLEX_REQ=$(python3 -c "
import json
req = {
    'jsonrpc': '2.0',
    'id': 't4',
    'method': 'tools/call',
    'params': {
        'name': 'gemini',
        'arguments': {
            'prompt': '''$COMPLEX_PROMPT''',
            'model': 'gemini-2.5-flash'
        }
    }
}
print(json.dumps(req))
")

result=$(send_rpc "$COMPLEX_REQ" 120)
complex_ms="${result%%|*}"
complex_resp="${result#*|}"

has_content=$(echo "$complex_resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{})
c=r.get('content',[])
print('ok' if c and not r.get('isError') else 'err')
" 2>/dev/null || echo "err")

if [ "$has_content" = "ok" ]; then
  log "  complex call: ${complex_ms}ms - OK"
else
  warn "  complex call: ${complex_ms}ms - ERROR"
  complex_ms=-1
fi

# --- Write results ---
python3 -c "
import json, datetime
results = {
    'label': '$LABEL',
    'timestamp': datetime.datetime.now().isoformat(),
    'bridge': '$BRIDGE',
    'metrics': {
        'init_ms': $init_ms,
        'tools_list_ms': $list_ms,
        'simple_call_ms': $simple_ms,
        'complex_call_ms': $complex_ms,
        'tool_count': $tool_count
    }
}
with open('$OUTFILE', 'w') as f:
    json.dump(results, f, indent=2)
print()
print(json.dumps(results, indent=2))
"

log "Results saved to $OUTFILE"

# --- Compare if both before and after exist ---
BEFORE="$RESULTS_DIR/before.json"
AFTER="$RESULTS_DIR/after.json"
if [ -f "$BEFORE" ] && [ -f "$AFTER" ]; then
  echo ""
  log "=== COMPARISON ==="
  python3 -c "
import json

with open('$BEFORE') as f: before = json.load(f)
with open('$AFTER') as f: after = json.load(f)

bm = before['metrics']
am = after['metrics']

print(f\"{'Metric':<20} {'Before':>10} {'After':>10} {'Delta':>10} {'Change':>10}\")
print('-' * 62)
for key in ['init_ms', 'tools_list_ms', 'simple_call_ms', 'complex_call_ms']:
    b, a = bm[key], am[key]
    if b > 0 and a > 0:
        delta = a - b
        pct = ((a - b) / b) * 100
        sign = '+' if delta > 0 else ''
        color = '\033[0;31m' if delta > 0 else '\033[0;32m'
        print(f'{key:<20} {b:>8}ms {a:>8}ms {sign}{delta:>7}ms {color}{sign}{pct:.1f}%\033[0m')
    else:
        print(f'{key:<20} {b:>8}ms {a:>8}ms       N/A        N/A')
"
fi
