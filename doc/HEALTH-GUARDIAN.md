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

### 2. Performance Dashboard

Real-time API and database query performance monitoring at `GET /api/performance/overview`. Tracks response times, error rates, slow queries, and Core Web Vitals (LCP, CLS, INP, FCP, TTFB) with configurable time windows. UI available in the Paperclip dashboard.

### 3. Deployment Gate (`scripts/deployment-gate.mjs`)

Pre-deploy validation script with 7 infrastructure checks: CI quality gates, staging/production health, SSL certificates, CSP compliance, deployment locks, and cache readiness. Creates Paperclip blocker issues on failure.

### 4. Health Endpoint (`GET /api/health`)

Core health probe returning server status, version, deployment mode, auth readiness, bootstrap state, and database connectivity.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Auto-Heal      │────▶│  Health Endpoint  │     │  Performance    │
│  (bash daemon)  │     │  GET /api/health  │     │  Dashboard      │
└────────┬────────┘     └──────────────────┘     └────────┬────────┘
         │                                                 │
         │  on failure                                     │  on thresholds
         ▼                                                 ▼
┌─────────────────┐                              ┌─────────────────┐
│  Paperclip API  │                              │  Optimization   │
│  (escalation)   │                              │  Suggestions    │
└─────────────────┘                              └─────────────────┘
```

## Integration Points

| Component | API | Escalation | Config |
|-----------|-----|------------|--------|
| Auto-Heal | `GET /api/health` | Paperclip API `PATCH /api/issues/{id}` | `AUTO_HEAL_*` env vars |
| Performance | `GET /api/performance/overview` | Optimization suggestions in overview | Window/minRequests params |
| Deployment Gate | Multi-endpoint | Paperclip blocker issues | CLI flags |
