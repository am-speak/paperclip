import type { Request, Response, NextFunction } from "express";
import { autoHeal } from "../services/auto-heal.js";

const SKIP_PATTERNS = [
  /^\/health/,
  /^\/performance/,
];

const ERROR_RATE_EVAL_INTERVAL_MS = 30_000;
let lastErrorRateEval = 0;

function maybeEvaluateErrorRates(): void {
  const now = Date.now();
  if (now - lastErrorRateEval > ERROR_RATE_EVAL_INTERVAL_MS) {
    lastErrorRateEval = now;
    autoHeal.evaluateErrorRates();
  }
}

export function circuitBreakerMiddleware(
  skipPatterns: RegExp[] = SKIP_PATTERNS,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path;

    maybeEvaluateErrorRates();

    for (const pattern of skipPatterns) {
      if (pattern.test(path)) {
        next();
        return;
      }
    }

    const route = (req.route?.path as string) ?? path ?? "/unknown";

    if (autoHeal.shouldCircuitBreak(route, req.method)) {
      res.status(503).json({
        error: "Service temporarily unavailable",
        detail: "Circuit breaker open for this route",
        route,
        method: req.method,
      });
      return;
    }

    const originalEnd = res.end.bind(res);
    res.end = function chunkEnd(...args: Parameters<typeof originalEnd>) {
      const statusCode = res.statusCode;
      if (statusCode >= 500) {
        autoHeal.reportFailure(route, req.method, statusCode);
      } else {
        autoHeal.reportSuccess(route, req.method);
      }
      return originalEnd(...args);
    } as typeof originalEnd;

    next();
  };
}
