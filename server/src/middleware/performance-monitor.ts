import type { Request, Response, NextFunction } from "express";
import type { WebVitalReport, PerformanceConfig } from "@paperclipai/shared";
import { performanceService, type PerformanceServiceOptions } from "../services/performance.js";
import { autoHeal } from "../services/auto-heal.js";

export const perfMonitor = performanceService();

export function configurePerformanceMonitor(config: PerformanceConfig): void {
  const opts: PerformanceServiceOptions = {
    maxBuffer: config.maxBufferSize,
    maxDbBuffer: config.maxDbBufferSize,
    slowQueryThresholdMs: config.slowQueryThresholdMs,
  };
  perfMonitor.configure(opts);
  autoHeal.configure({
    openCooldownMs: config.circuitBreaker?.openCooldownMs,
    halfOpenMaxAttempts: config.circuitBreaker?.halfOpenMaxAttempts,
    maxConsecutiveTrips: config.circuitBreaker?.maxConsecutiveTrips,
    maxClosedFailures: config.circuitBreaker?.maxClosedFailures,
  });
}

export function performanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();

  res.once("finish", () => {
    const durationMs = Math.round(performance.now() - start);
    const route = (req.route?.path as string) ?? req.path ?? "/unknown";
    perfMonitor.record({
      route,
      method: req.method,
      statusCode: res.statusCode,
      durationMs,
      timestamp: Date.now(),
    });
  });

  next();
}

export function createDbQueryCallback() {
  return (info: { sql: string; durationMs: number; error?: string }) => {
    perfMonitor.recordDbQuery({
      query: info.sql,
      durationMs: info.durationMs,
      timestamp: Date.now(),
    });
  };
}

export function recordWebVitals(report: WebVitalReport): void {
  perfMonitor.recordWebVitals(report);
}
