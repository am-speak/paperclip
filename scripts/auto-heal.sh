#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Auto-Heal — 500 Detection & Recovery
#
# Detects HTTP 500 errors on configured critical routes, runs recovery
# commands, verifies the fix, and escalates to the board after N failures.
#
# Usage:
#   scripts/auto-heal.sh [options]
#
# Options:
#   --once          Run a single check cycle (no continuous loop)
#   --verbose       Enable verbose output
#   --dry-run       Print actions without executing
#   --help          Show this help
#
# Configuration (env vars):
#   AUTO_HEAL_ROUTES         Space-separated URL list (default: localhost:3100/api/health)
#   AUTO_HEAL_RECOVERY_CMDS  Semicolon-separated recovery commands
#   AUTO_HEAL_MAX_ATTEMPTS   Max recovery attempts before escalation (default: 3)
#   AUTO_HEAL_VERIFY_WAIT    Seconds to wait after recovery before verify (default: 5)
#   AUTO_HEAL_STATE_DIR      Directory for attempt tracking (default: /tmp/auto-heal)
#   PAPERCLIP_API_URL        Paperclip API base URL (for escalation)
#   PAPERCLIP_API_KEY        Paperclip API key
#   PAPERCLIP_RUN_ID         Current run ID
#   PAPERCLIP_TASK_ID        Issue ID for status updates
# =============================================================================

usage() {
  cat <<'EOF'
Usage:
  scripts/auto-heal.sh [--once] [--verbose] [--dry-run] [--help]

Detects 500s on critical routes, runs recovery commands, verifies,
and escalates to the board after repeated failures.

Configuration via environment variables:
  AUTO_HEAL_ROUTES         (default: http://localhost:3100/api/health)
  AUTO_HEAL_RECOVERY_CMDS  (default: pnpm install --frozen-lockfile; pnpm build; systemctl restart paperclip-server)
  AUTO_HEAL_MAX_ATTEMPTS   (default: 3)
  AUTO_HEAL_VERIFY_WAIT    Seconds before verify (default: 5)
  AUTO_HEAL_STATE_DIR      (default: /tmp/auto-heal)
  PAPERCLIP_API_URL        Paperclip API base URL
  PAPERCLIP_API_KEY        Paperclip API key
  PAPERCLIP_RUN_ID         Current run ID
  PAPERCLIP_TASK_ID        Issue ID for status updates
EOF
}

# ── Defaults ──────────────────────────────────────────────────────────────────
MAX_ATTEMPTS="${AUTO_HEAL_MAX_ATTEMPTS:-3}"
VERIFY_WAIT="${AUTO_HEAL_VERIFY_WAIT:-5}"
STATE_DIR="${AUTO_HEAL_STATE_DIR:-/tmp/auto-heal}"
ONLY_ONCE=0
VERBOSE=0
DRY_RUN=0

# Critical routes to monitor — override via AUTO_HEAL_ROUTES env var
if [[ -n "${AUTO_HEAL_ROUTES:-}" ]]; then
  IFS=' ' read -ra ROUTES <<< "$AUTO_HEAL_ROUTES"
else
  ROUTES=(
    "http://localhost:3100/api/health"
  )
fi

# Recovery commands — override via AUTO_HEAL_RECOVERY_CMDS env var (semicolon-separated).
# Defaults are Paperclip-native (Node.js/pnpm).
if [[ -n "${AUTO_HEAL_RECOVERY_CMDS:-}" ]]; then
  IFS=';' read -ra RECOVERY_CMDS <<< "$AUTO_HEAL_RECOVERY_CMDS"
else
  RECOVERY_CMDS=(
    "pnpm install --frozen-lockfile"
    "pnpm build"
    "systemctl --user restart paperclip-server"
  )
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
info() { log "INFO  $*"; }
warn() { log "WARN  $*"; }
err()  { log "ERROR $*"; }

verbose() {
  if [[ "$VERBOSE" == "1" ]]; then
    log "DEBUG $*"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    exit 1
  fi
}

# ── State file helpers ────────────────────────────────────────────────────────
state_file() {
  local route_hash
  route_hash=$(printf '%s' "$1" | shasum 2>/dev/null | cut -c1-16 || printf '%s' "$1" | sha256sum 2>/dev/null | cut -c1-16 || printf '%s' "$1" | md5 2>/dev/null | cut -c1-16)
  mkdir -p "$STATE_DIR"
  printf '%s' "${STATE_DIR}/heal-${route_hash}.state"
}

read_attempts() {
  local route="$1" sf
  sf=$(state_file "$route")
  if [[ -f "$sf" ]]; then
    cat "$sf"
  else
    echo "0"
  fi
}

write_attempts() {
  local route="$1" count="$2" sf
  sf=$(state_file "$route")
  printf '%s' "$count" > "$sf"
}

reset_attempts() {
  local route="$1" sf
  sf=$(state_file "$route")
  rm -f "$sf"
}

# ── HTTP check ────────────────────────────────────────────────────────────────
check_route() {
  local url="$1"
  local http_code

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "200"
    return
  fi

  http_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo "000")
  printf '%s' "$http_code"
}

# ── Recovery execution ────────────────────────────────────────────────────────
run_recovery() {
  info "Running recovery commands..."

  for cmd in "${RECOVERY_CMDS[@]}"; do
    cmd_trimmed="${cmd#"${cmd%%[![:space:]]*}"}"
    cmd_trimmed="${cmd_trimmed%"${cmd_trimmed##*[![:space:]]}"}"
    if [[ -z "$cmd_trimmed" ]]; then
      continue
    fi

    info "  Running: $cmd_trimmed"
    if [[ "$DRY_RUN" == "1" ]]; then
      info "  [dry-run] would execute: $cmd_trimmed"
      continue
    fi

    if bash -c "$cmd_trimmed" 2>&1; then
      verbose "  => completed successfully"
    else
      warn "  => exited with non-zero status"
    fi
  done

  info "Recovery commands finished."
}

# ── Verification ──────────────────────────────────────────────────────────────
verify_routes() {
  local all_ok=0

  info "Verifying routes after recovery (waiting ${VERIFY_WAIT}s)..."
  sleep "$VERIFY_WAIT"

  for url in "${ROUTES[@]}"; do
    local code
    code=$(check_route "$url")
    if [[ "$code" == "200" || "$code" == "000" && "$DRY_RUN" == "1" ]]; then
      info "  $url => $code (OK)"
    else
      warn "  $url => $code (still failing)"
      all_ok=1
    fi
  done

  return "$all_ok"
}

# ── Escalation ────────────────────────────────────────────────────────────────
escalate_to_board() {
  local route="$1" attempts="$2"

  warn "Escalating to board after ${attempts} failed attempts for route: $route"

  if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" ]]; then
    warn "Paperclip API credentials not configured — cannot create escalation issue."
    warn "Would escalate: Auto-Heal exceeded ${attempts} attempts on ${route}"
    return
  fi

  local company_id="${PAPERCLIP_COMPANY_ID:-}"
  local issue_id="${PAPERCLIP_TASK_ID:-}"

  local summary="Auto-Heal exceeded ${MAX_ATTEMPTS} recovery attempts for route ${route}"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "  [dry-run] would escalate via Paperclip API"
    return
  fi

  if [[ -n "$issue_id" ]]; then
    # Update the existing issue with escalation status
    local payload
    payload=$(jq -nc \
      --arg comment "## Auto-Heal Escalation

**Route:** ${route}
**Failed attempts:** ${attempts}/${MAX_ATTEMPTS}
**Time:** $(date -u '+%Y-%m-%dT%H:%M:%SZ')

All recovery attempts exhausted. Manual intervention required.

### Recovery commands attempted:
$(printf ' - `%s`\n' "${RECOVERY_CMDS[@]}")

### Next steps:
1. Investigate the root cause of the persistent 500 errors
2. Apply a permanent fix
3. Reset the auto-heal state: \`rm -f ${STATE_DIR}/heal-*\`
4. Re-run verification: \`scripts/auto-heal.sh --once\`" \
      --arg status "blocked" \
      '{
        status: $status,
        comment: $comment
      }')

    curl -sS -X PATCH \
      "${PAPERCLIP_API_URL}/api/issues/${issue_id}" \
      -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
      -H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID:-}" \
      -H "Content-Type: application/json" \
      --data-binary "$payload" >/dev/null 2>&1 && \
      info "  Updated issue ${issue_id} with escalation status"
  fi
}

# ── Single heal cycle ─────────────────────────────────────────────────────────
heal_cycle() {
  local any_failing=0

  for url in "${ROUTES[@]}"; do
    verbose "Checking route: $url"

    local code
    code=$(check_route "$url")

    if [[ "$code" == "200" ]]; then
      verbose "  $url => ${code} (healthy)"
      continue
    fi

    if [[ "$code" == "000" ]]; then
      warn "  $url => connection failed (unreachable)"
    else
      warn "  $url => ${code} (error detected)"
    fi

    # Route is failing — read or initialize attempt counter
    local attempts
    attempts=$(read_attempts "$url")
    attempts=$((attempts + 1))
    write_attempts "$url" "$attempts"

    info "  Recovery attempt ${attempts}/${MAX_ATTEMPTS} for ${url}"

    if [[ "$attempts" -gt "$MAX_ATTEMPTS" ]]; then
      escalate_to_board "$url" "$attempts"
      any_failing=1
      continue
    fi

    # Run recovery
    run_recovery

    # Verify
    if verify_routes; then
      info "  Auto-heal successful for ${url} after ${attempts} attempt(s)"
      reset_attempts "$url"
      # Report success back via Paperclip
      if [[ -n "${PAPERCLIP_TASK_ID:-}" && -n "${PAPERCLIP_API_URL:-}" ]]; then
        local success_comment
        success_comment=$(jq -nc \
          --arg url "$url" \
          --arg attempts "$attempts" \
          "Auto-heal recovered ${url} after ${attempts} attempt(s)")
        local payload
        payload=$(jq -nc \
          --arg comment "$success_comment" \
          '{comment: $comment}')
        curl -sS -X PATCH \
          "${PAPERCLIP_API_URL}/api/issues/${PAPERCLIP_TASK_ID}" \
          -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
          -H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID:-}" \
          -H "Content-Type: application/json" \
          --data-binary "$payload" >/dev/null 2>&1 || true
      fi
    else
      warn "  Recovery attempt ${attempts} did not resolve the issue for ${url}"
      any_failing=1
      if [[ "$attempts" -ge "$MAX_ATTEMPTS" ]]; then
        escalate_to_board "$url" "$attempts"
      fi
    fi
  done

  return "$any_failing"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --once)    ONLY_ONCE=1; shift ;;
      --verbose) VERBOSE=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *)         err "Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  # Prerequisites
  require_command curl
  require_command jq

  info "Auto-Heal starting"
  info "  Routes: ${ROUTES[*]}"
  info "  Max attempts: ${MAX_ATTEMPTS}"
  info "  State dir: ${STATE_DIR}"
  if [[ "$DRY_RUN" == "1" ]]; then
    info "  DRY RUN — no changes will be made"
  fi

  if [[ "$ONLY_ONCE" == "1" ]]; then
    heal_cycle
    exit $?
  fi

  # Continuous loop mode — runs every 60s
  info "Continuous mode (Ctrl+C to stop)"
  while true; do
    heal_cycle || true
    sleep 60
  done
}

main "$@"
