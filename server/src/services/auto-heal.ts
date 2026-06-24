import { perfMonitor } from "../middleware/performance-monitor.js";

export interface AutoHealServiceOptions {
  openCooldownMs?: number;
  halfOpenMaxAttempts?: number;
  maxConsecutiveTrips?: number;
  maxClosedFailures?: number;
}

type CircuitState = "closed" | "open" | "half_open";

interface CircuitBreakerEntry {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: number;
  lastTripAt: number;
  halfOpenAttempts: number;
  consecutiveTrips: number;
}

export interface RouteHealthInfo {
  route: string;
  method: string;
  circuitState: CircuitState;
  errorRate: number;
  errorCount: number;
  totalCount: number;
  lastFailureAt: string | null;
  consecutiveTrips: number;
}

const circuitBreakers = new Map<string, CircuitBreakerEntry>();

function routeKey(route: string, method: string): string {
  return `${method} ${route}`;
}

function getOrCreate(key: string): CircuitBreakerEntry {
  let entry = circuitBreakers.get(key);
  if (!entry) {
    entry = { state: "closed", failureCount: 0, lastFailureAt: 0, lastTripAt: 0, halfOpenAttempts: 0, consecutiveTrips: 0 };
    circuitBreakers.set(key, entry);
  }
  return entry;
}

export function autoHealService(opts?: AutoHealServiceOptions) {
  let openCooldownMs = opts?.openCooldownMs ?? 30_000;
  let halfOpenMaxAttempts = opts?.halfOpenMaxAttempts ?? 3;
  let maxConsecutiveTrips = opts?.maxConsecutiveTrips ?? 3;
  let maxClosedFailures = opts?.maxClosedFailures ?? 10;

  function configure(opts: AutoHealServiceOptions): void {
    if (opts.openCooldownMs !== undefined) openCooldownMs = opts.openCooldownMs;
    if (opts.halfOpenMaxAttempts !== undefined) halfOpenMaxAttempts = opts.halfOpenMaxAttempts;
    if (opts.maxConsecutiveTrips !== undefined) maxConsecutiveTrips = opts.maxConsecutiveTrips;
    if (opts.maxClosedFailures !== undefined) maxClosedFailures = opts.maxClosedFailures;
  }

  function shouldCircuitBreak(route: string, method: string): boolean {
    const key = routeKey(route, method);
    const cb = getOrCreate(key);

    if (cb.state === "open") {
      if (Date.now() - cb.lastTripAt >= openCooldownMs) {
        cb.state = "half_open";
        cb.halfOpenAttempts = 0;
        return false;
      }
      return true;
    }

    return false;
  }

  function reportSuccess(route: string, method: string): void {
    const key = routeKey(route, method);
    const cb = getOrCreate(key);

    if (cb.state === "half_open") {
      cb.state = "closed";
      cb.failureCount = 0;
      cb.consecutiveTrips = 0;
      cb.halfOpenAttempts = 0;
      return;
    }

    if (cb.state === "closed") {
      cb.failureCount = 0;
    }
  }

  function reportFailure(route: string, method: string, _statusCode: number): void {
    const key = routeKey(route, method);
    const cb = getOrCreate(key);

    cb.failureCount++;
    cb.lastFailureAt = Date.now();

    if (cb.state === "half_open") {
      cb.halfOpenAttempts++;
      if (cb.halfOpenAttempts >= halfOpenMaxAttempts) {
        cb.state = "open";
        cb.lastTripAt = Date.now();
        cb.consecutiveTrips++;
      }
      return;
    }

    if (cb.state === "closed") {
      if (cb.failureCount >= maxClosedFailures) {
        cb.state = "open";
        cb.lastTripAt = Date.now();
        cb.consecutiveTrips++;
        cb.failureCount = 0;
      }
    }
  }

  function evaluateErrorRates(windowSeconds = 120, minRequests = 10): void {
    const overview = perfMonitor.overview({ windowSeconds, minRequests });

    for (const route of overview.topErrorRoutes) {
      const key = routeKey(route.route, route.method);
      const cb = getOrCreate(key);

      if (cb.state !== "closed") continue;

      if (route.errorRate > 20 && route.totalCount >= minRequests) {
        cb.state = "open";
        cb.lastTripAt = Date.now();
        cb.consecutiveTrips++;
      }
    }
  }

  function getRouteHealth(windowSeconds?: number): RouteHealthInfo[] {
    evaluateErrorRates(windowSeconds);
    const overview = perfMonitor.overview({ windowSeconds, minRequests: 1 });

    const routeErrorMap = new Map<string, { errorCount: number; totalCount: number; errorRate: number }>();

    for (const err of overview.topErrorRoutes) {
      const key = routeKey(err.route, err.method);
      routeErrorMap.set(key, { errorCount: err.errorCount, totalCount: err.totalCount, errorRate: err.errorRate });
    }

    const seen = new Set<string>();
    const result: RouteHealthInfo[] = [];

    for (const bucket of overview.buckets) {
      const key = routeKey(bucket.route, bucket.method);
      if (seen.has(key)) continue;
      seen.add(key);

      const errData = routeErrorMap.get(key);
      const cb = getOrCreate(key);

      result.push({
        route: bucket.route,
        method: bucket.method,
        circuitState: cb.state,
        errorRate: errData?.errorRate ?? 0,
        errorCount: errData?.errorCount ?? 0,
        totalCount: bucket.count,
        lastFailureAt: cb.lastFailureAt > 0 ? new Date(cb.lastFailureAt).toISOString() : null,
        consecutiveTrips: cb.consecutiveTrips,
      });
    }

    for (const [key, cb] of circuitBreakers) {
      if (seen.has(key)) continue;
      const spaceIdx = key.indexOf(" ");
      const method = key.slice(0, spaceIdx);
      const route = key.slice(spaceIdx + 1);
      const errData = routeErrorMap.get(key);

      result.push({
        route,
        method,
        circuitState: cb.state,
        errorRate: errData?.errorRate ?? 0,
        errorCount: errData?.errorCount ?? 0,
        totalCount: errData?.totalCount ?? 0,
        lastFailureAt: cb.lastFailureAt > 0 ? new Date(cb.lastFailureAt).toISOString() : null,
        consecutiveTrips: cb.consecutiveTrips,
      });
    }

    return result.sort((a, b) => b.errorRate - a.errorRate);
  }

  function resetRoute(route: string, method: string): boolean {
    const key = routeKey(route, method);
    const cb = circuitBreakers.get(key);
    if (!cb) return false;
    cb.state = "closed";
    cb.failureCount = 0;
    cb.consecutiveTrips = 0;
    cb.halfOpenAttempts = 0;
    cb.lastTripAt = 0;
    return true;
  }

  function resetAll(): void {
    circuitBreakers.clear();
  }

  return {
    shouldCircuitBreak,
    reportSuccess,
    reportFailure,
    evaluateErrorRates,
    getRouteHealth,
    resetRoute,
    resetAll,
    configure,
  };
}

export type AutoHealService = ReturnType<typeof autoHealService>;

export const autoHeal = autoHealService();
