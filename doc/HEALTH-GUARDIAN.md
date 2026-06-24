# Platform Health Guardian

The Platform Health Guardian is a set of automated systems that monitor Paperclip platform health, detect failures, attempt self-healing, and escalate when recovery is not possible.

## Components

### 1. Auto-Heal (`scripts/auto-heal.sh`)

A bash daemon that polls critical HTTP routes, detects 500 errors, runs configurable recovery commands, and escalates to the board after repeated failures.

- **Monitoring**: polls configured routes (default: `http://localhost:3100/api/health`) every 60s
- **Recovery**: runs Paperclip-native recovery commands (`pnpm install --frozen-lockfile`, `pnpm build`, service restart)
- **Escalation**: creates a `blocked` issue with full context via the Paperclip API after N consecutive failures
- **Deployment**: ships as a systemd service (`scripts/auto-heal.service`)

```bash
# Single check (for cron):
scripts/auto-heal.sh --once

# Continuous monitoring (for systemd):
scripts/auto-heal.sh

# Dry-run verification:
scripts/auto-heal.sh --once --dry-run --verbose
```

### 2. Circuit Breaker (Server-Side Middleware)

An in-process Express middleware that prevents cascading failures by automatically short-circuiting routes that are consistently returning 5xx errors.

- **Detection**: monitors per-route error rates from the in-memory performance buffer
- **States**: CLOSED (normal) → OPEN (rejecting requests with 503) → HALF_OPEN (limited probes)
- **Trip threshold**: 10 consecutive 5xx responses or >20% error rate in a 120s window
- **Cooldown**: OPEN circuits auto-transition to HALF_OPEN after 30s
- **Recovery**: a successful HALF_OPEN probe resets to CLOSED; sustained failures in HALF_OPEN re-trip
- **Exclusions**: health and performance endpoints are never circuit-broken
- **Implementation**: `server/src/services/auto-heal.ts` (state machine), `server/src/middleware/circuit-breaker.ts` (Express middleware)

### 3. Route Health Endpoint (`GET /api/health/routes`)

Per-route health visibility endpoint that exposes circuit breaker state and error rates for every monitored API route.

- **Usage**: `GET /api/health/routes` returns `{ routes: RouteHealthInfo[], monitored: number }`
- **Each entry includes**: route, method, circuitState, errorRate, errorCount, totalCount, lastFailureAt, consecutiveTrips
- **Reset**: `POST /api/health/routes/reset` with `{ route, method }` body resets a single route; empty body resets all
- **Used by**: auto-heal bash daemon for targeted per-route monitoring and recovery

### 4. Performance Dashboard

Real-time API and database query performance monitoring at `GET /api/performance/overview`. Tracks response times, error rates, slow queries, and Core Web Vitals (LCP, CLS, INP, FCP, TTFB) with configurable time windows. UI available in the Paperclip dashboard.

### 5. Deployment Gate (`scripts/deployment-gate.mjs`)

Pre-deploy validation script with 7 infrastructure checks: CI quality gates, staging/production health, SSL certificates, CSP compliance, deployment locks, and cache readiness. Creates Paperclip blocker issues on failure.

### 6. Health Endpoint (`GET /api/health`)

Core health probe returning server status, version, deployment mode, auth readiness, bootstrap state, and database connectivity.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Auto-Heal      │────▶│  Health Endpoint  │     │  Performance    │
│  (bash daemon)  │     │  GET /api/health  │     │  Service        │
└────────┬────────┘     └──────┬───────────┘     └────────┬────────┘
         │                     │                           │
         │  on failure         │  per-route health         │  error rates
         ▼                     ▼                           ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Paperclip API  │     │  Circuit Breaker  │◀────│  Auto-Heal      │
│  (escalation)   │     │  (Express MW)     │     │  Service        │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                │  503 on OPEN
                                ▼
                         ┌──────────────────┐
                         │  Failing Routes   │
                         │  (isolated)       │
                         └──────────────────┘
```

**Failure flow:**
1. Route returns 5xx → Performance service records error
2. Auto-heal service detects sustained error rate → trips circuit breaker to OPEN
3. Circuit breaker middleware returns 503 immediately without hitting the route handler
4. After 30s cooldown → circuit transitions to HALF_OPEN, single request allowed through
5a. Success → circuit closes, normal operation resumes
5b. Failure → circuit re-opens, escalates after MAX_CONSECUTIVE_TRIPS cycles

## Integration Points

| Component | API | Escalation | Config |
|-----------|-----|------------|--------|
| Auto-Heal | `GET /api/health` | Paperclip API `PATCH /api/issues/{id}` | `AUTO_HEAL_*` env vars |
| Circuit Breaker | In-process (performance buffer) | Auto-heal service escalation | Threshold constants in `auto-heal.ts` |
| Route Health | `GET /api/health/routes` | Manual reset via `POST /api/health/routes/reset` | N/A |
| Performance | `GET /api/performance/overview` | Optimization suggestions in overview | Window/minRequests params |
| Deployment Gate | Multi-endpoint | Paperclip blocker issues | CLI flags |
