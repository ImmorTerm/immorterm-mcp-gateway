#!/bin/bash
# ============================================================================
# MCP Gateway Stress Test
# ============================================================================
# Tests the gateway under realistic and extreme conditions:
#   1. Init race condition (the bug we just fixed)
#   2. Concurrent stateless requests (shared child multiplexing)
#   3. Concurrent stateful sessions (per-session children)
#   4. Mixed workload (stateless + stateful interleaved)
#   5. Rapid session creation (spawn storm)
# ============================================================================

set -euo pipefail

GW_URL="http://localhost:9100"
PASS=0
FAIL=0
TOTAL=0
ERRORS=()

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

passed() { ((PASS++)); ((TOTAL++)); echo -e "  ${GREEN}PASS${NC} $1"; }
failed() { ((FAIL++)); ((TOTAL++)); ERRORS+=("$1: $2"); echo -e "  ${RED}FAIL${NC} $1 — $2"; }

section() { echo -e "\n${CYAN}${BOLD}── $1 ──${NC}"; }

# ── Helper: full MCP handshake, returns session ID ──
# Usage: SESSION_ID=$(handshake "serena")
handshake() {
  local server="$1"
  local sid
  sid=$(curl -sD /dev/stderr -X POST "$GW_URL/$server/mcp" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"stress-test","version":"1.0"}}}' \
    2>&1 1>/dev/null | grep -i mcp-session-id | tr -d '\r\n' | awk '{print $2}')

  # Send notifications/initialized
  curl -s -X POST "$GW_URL/$server/mcp" \
    -H "Content-Type: application/json" \
    -H "Mcp-Session-Id: $sid" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

  echo "$sid"
}

# ── Helper: send a tool call and check for errors ──
# Usage: result=$(tool_call "serena" "$SESSION_ID" 2 "activate_project" '{"project":"immorterm"}')
tool_call() {
  local server="$1" sid="$2" reqid="$3" tool="$4" args="$5"
  curl -s --max-time 30 -X POST "$GW_URL/$server/mcp" \
    -H "Content-Type: application/json" \
    -H "Mcp-Session-Id: $sid" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$reqid,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

# ── Helper: check result for errors ──
check_result() {
  local label="$1" result="$2"
  if echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'result' in d else 1)" 2>/dev/null; then
    passed "$label"
  else
    local err
    err=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','unknown'))" 2>/dev/null || echo "$result")
    failed "$label" "$err"
  fi
}

# ============================================================================
echo -e "${BOLD}MCP Gateway Stress Test${NC}"
echo "Gateway: $GW_URL"

# Verify gateway is up
if ! curl -s "$GW_URL/health" > /dev/null 2>&1; then
  echo -e "${RED}Gateway not running!${NC}"
  exit 1
fi
echo -e "Status: $(curl -s "$GW_URL/health" | python3 -c "import json,sys; h=json.load(sys.stdin); print(f\"{h['status']} — {len(h['servers'])} servers, {h['totalChildren']} children, {h['memoryMB']} MB\")")"

# ============================================================================
section "1. Init Race Condition (stateful servers)"
# The exact bug we fixed: initialize → notifications/initialized → immediate tool call
# Should NOT get -32602 "Received request before initialization was complete"

for server in serena sequential-thinking; do
  sid=$(handshake "$server")
  if [ "$server" = "serena" ]; then
    result=$(tool_call "$server" "$sid" 2 "activate_project" '{"project":"immorterm"}')
  else
    result=$(tool_call "$server" "$sid" 2 "sequentialthinking" '{"thought":"test","thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":false}')
  fi
  check_result "Init race: $server" "$result"
done

# ============================================================================
section "2. Concurrent Stateless Requests (shared child multiplexing)"
# Fire N requests to the same stateless server simultaneously.
# All should return correct results matched by JSON-RPC ID.

CONCURRENT=20
TMPDIR_STRESS=$(mktemp -d)

echo "  Firing $CONCURRENT concurrent requests to context7..."
for i in $(seq 1 $CONCURRENT); do
  (
    sid=$(handshake "context7")
    result=$(curl -s --max-time 30 -X POST "$GW_URL/context7/mcp" \
      -H "Content-Type: application/json" \
      -H "Mcp-Session-Id: $sid" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/list\",\"params\":{}}")
    echo "$result" > "$TMPDIR_STRESS/stateless_$i.json"
  ) &
done
wait

stateless_ok=0
stateless_fail=0
for i in $(seq 1 $CONCURRENT); do
  f="$TMPDIR_STRESS/stateless_$i.json"
  if [ -f "$f" ] && python3 -c "import json; d=json.load(open('$f')); assert 'result' in d" 2>/dev/null; then
    ((stateless_ok++))
  else
    ((stateless_fail++))
  fi
done

if [ $stateless_fail -eq 0 ]; then
  passed "Stateless concurrency: $stateless_ok/$CONCURRENT succeeded"
else
  failed "Stateless concurrency" "$stateless_fail/$CONCURRENT failed"
fi

# ============================================================================
section "3. Concurrent Stateful Sessions (per-session children)"
# Spawn N Serena sessions simultaneously, each doing full handshake + tool call.

SESSIONS=10
echo "  Spawning $SESSIONS concurrent Serena sessions..."

for i in $(seq 1 $SESSIONS); do
  (
    sid=$(handshake "serena")
    result=$(tool_call "serena" "$sid" 2 "activate_project" '{"project":"immorterm"}')
    echo "$result" > "$TMPDIR_STRESS/stateful_$i.json"
  ) &
done
wait

stateful_ok=0
stateful_fail=0
for i in $(seq 1 $SESSIONS); do
  f="$TMPDIR_STRESS/stateful_$i.json"
  if [ -f "$f" ] && python3 -c "import json; d=json.load(open('$f')); assert 'result' in d" 2>/dev/null; then
    ((stateful_ok++))
  else
    ((stateful_fail++))
  fi
done

if [ $stateful_fail -eq 0 ]; then
  passed "Stateful concurrency: $stateful_ok/$SESSIONS sessions succeeded"
else
  failed "Stateful concurrency" "$stateful_fail/$SESSIONS failed"
fi

# ============================================================================
section "4. JSON-RPC ID Routing Correctness"
# Send requests with specific IDs and verify responses have matching IDs.
# This catches the supergateway bug (broadcasting to all clients).

echo "  Verifying ID routing across 10 concurrent requests..."
for i in $(seq 1 10); do
  reqid=$((1000 + i))
  (
    sid=$(handshake "tavily")
    result=$(curl -s --max-time 30 -X POST "$GW_URL/tavily/mcp" \
      -H "Content-Type: application/json" \
      -H "Mcp-Session-Id: $sid" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$reqid,\"method\":\"tools/list\",\"params\":{}}")
    echo "$result" > "$TMPDIR_STRESS/routing_$i.json"
  ) &
done
wait

routing_ok=0
routing_fail=0
for i in $(seq 1 10); do
  reqid=$((1000 + i))
  f="$TMPDIR_STRESS/routing_$i.json"
  if [ -f "$f" ] && python3 -c "import json; d=json.load(open('$f')); assert d.get('id') == $reqid, f'Expected $reqid got {d.get(\"id\")}'" 2>/dev/null; then
    ((routing_ok++))
  else
    ((routing_fail++))
  fi
done

if [ $routing_fail -eq 0 ]; then
  passed "ID routing: all $routing_ok responses matched their request IDs"
else
  failed "ID routing" "$routing_fail/10 had mismatched IDs"
fi

# ============================================================================
section "5. Mixed Workload (stateless + stateful interleaved)"
# Simulate real usage: multiple servers hit simultaneously.

echo "  Firing mixed requests to 5 servers simultaneously..."
MIXED_SERVERS=("context7" "tavily" "magic" "morph-fast-tools" "iconfont-mcp")
for i in "${!MIXED_SERVERS[@]}"; do
  server="${MIXED_SERVERS[$i]}"
  (
    sid=$(handshake "$server")
    result=$(curl -s --max-time 30 -X POST "$GW_URL/$server/mcp" \
      -H "Content-Type: application/json" \
      -H "Mcp-Session-Id: $sid" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$((i+1)),\"method\":\"tools/list\",\"params\":{}}")
    echo "$result" > "$TMPDIR_STRESS/mixed_$i.json"
  ) &
done
# Plus 3 stateful Serena sessions
for i in $(seq 0 2); do
  (
    sid=$(handshake "serena")
    result=$(tool_call "serena" "$sid" 2 "activate_project" '{"project":"immorterm"}')
    echo "$result" > "$TMPDIR_STRESS/mixed_serena_$i.json"
  ) &
done
wait

mixed_ok=0
mixed_fail=0
for i in "${!MIXED_SERVERS[@]}"; do
  f="$TMPDIR_STRESS/mixed_$i.json"
  if [ -f "$f" ] && python3 -c "import json; d=json.load(open('$f')); assert 'result' in d" 2>/dev/null; then
    ((mixed_ok++))
  else
    ((mixed_fail++))
  fi
done
for i in $(seq 0 2); do
  f="$TMPDIR_STRESS/mixed_serena_$i.json"
  if [ -f "$f" ] && python3 -c "import json; d=json.load(open('$f')); assert 'result' in d" 2>/dev/null; then
    ((mixed_ok++))
  else
    ((mixed_fail++))
  fi
done

if [ $mixed_fail -eq 0 ]; then
  passed "Mixed workload: $mixed_ok/8 all succeeded"
else
  failed "Mixed workload" "$mixed_fail/8 failed"
fi

# ============================================================================
section "6. Rapid Fire (throughput test)"
# Send 50 sequential requests to a stateless server as fast as possible.

echo "  Sending 50 rapid-fire requests to context7..."
RAPID=50
sid=$(handshake "context7")
rapid_ok=0
rapid_fail=0
START_TIME=$(python3 -c "import time; print(time.time())")

for i in $(seq 1 $RAPID); do
  result=$(curl -s --max-time 10 -X POST "$GW_URL/context7/mcp" \
    -H "Content-Type: application/json" \
    -H "Mcp-Session-Id: $sid" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/list\",\"params\":{}}")
  if echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'result' in d" 2>/dev/null; then
    ((rapid_ok++))
  else
    ((rapid_fail++))
  fi
done

END_TIME=$(python3 -c "import time; print(time.time())")
ELAPSED=$(python3 -c "print(f'{$END_TIME - $START_TIME:.1f}')")
RPS=$(python3 -c "print(f'{$RAPID / ($END_TIME - $START_TIME):.1f}')")

if [ $rapid_fail -eq 0 ]; then
  passed "Rapid fire: $rapid_ok/$RAPID in ${ELAPSED}s (${RPS} req/s)"
else
  failed "Rapid fire" "$rapid_fail/$RAPID failed (${ELAPSED}s, ${RPS} req/s)"
fi

# ============================================================================
section "7. Spawn Storm (many stateful sessions at once)"
# Create 15 stateful sessions simultaneously — tests child pool under pressure.

STORM=15
echo "  Spawning $STORM sequential-thinking sessions simultaneously..."

for i in $(seq 1 $STORM); do
  (
    sid=$(handshake "sequential-thinking")
    result=$(tool_call "sequential-thinking" "$sid" 2 "sequentialthinking" \
      "{\"thought\":\"Storm test $i\",\"thoughtNumber\":1,\"totalThoughts\":1,\"nextThoughtNeeded\":false}")
    echo "$result" > "$TMPDIR_STRESS/storm_$i.json"
  ) &
done
wait

storm_ok=0
storm_fail=0
for i in $(seq 1 $STORM); do
  f="$TMPDIR_STRESS/storm_$i.json"
  if [ -f "$f" ] && python3 -c "import json; d=json.load(open('$f')); assert 'result' in d" 2>/dev/null; then
    ((storm_ok++))
  else
    ((storm_fail++))
  fi
done

if [ $storm_fail -eq 0 ]; then
  passed "Spawn storm: $storm_ok/$STORM sessions created and used successfully"
else
  failed "Spawn storm" "$storm_fail/$STORM failed"
fi

# ============================================================================
section "8. Error Handling"

# Unknown server
result=$(curl -s -X POST "$GW_URL/nonexistent/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
if echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('error',{}).get('code') == -32601" 2>/dev/null; then
  passed "Unknown server returns proper error"
else
  failed "Unknown server" "unexpected response: $result"
fi

# Malformed JSON
result=$(curl -s -X POST "$GW_URL/context7/mcp" \
  -H "Content-Type: application/json" \
  -d 'not json at all')
if echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('error',{}).get('code') == -32700" 2>/dev/null; then
  passed "Malformed JSON returns parse error"
else
  failed "Malformed JSON" "unexpected response: $result"
fi

# ============================================================================
# Final health check
section "9. Post-Stress Health Check"
HEALTH=$(curl -s "$GW_URL/health")
STATUS=$(echo "$HEALTH" | python3 -c "import json,sys; h=json.load(sys.stdin); print(h['status'])")
CHILDREN=$(echo "$HEALTH" | python3 -c "import json,sys; h=json.load(sys.stdin); print(h['totalChildren'])")
MEM=$(echo "$HEALTH" | python3 -c "import json,sys; h=json.load(sys.stdin); print(h['memoryMB'])")

if [ "$STATUS" = "ok" ]; then
  passed "Gateway healthy after stress: $CHILDREN children, ${MEM} MB"
else
  failed "Post-stress health" "status=$STATUS"
fi

# ============================================================================
# Cleanup
rm -rf "$TMPDIR_STRESS"

echo -e "\n${BOLD}═══════════════════════════════════════${NC}"
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}${BOLD}ALL $TOTAL TESTS PASSED${NC}"
else
  echo -e "${RED}${BOLD}$FAIL/$TOTAL TESTS FAILED${NC}"
  echo -e "\nFailures:"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}x${NC} $err"
  done
fi
echo -e "${BOLD}═══════════════════════════════════════${NC}"

exit $FAIL
