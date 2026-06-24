import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { autoHealService } from "../services/auto-heal.js";
import { perfMonitor } from "../middleware/performance-monitor.js";

describe("autoHealService", () => {
  let svc: ReturnType<typeof autoHealService>;

  beforeEach(() => {
    vi.useFakeTimers();
    svc = autoHealService();
    svc.resetAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("shouldCircuitBreak", () => {
    it("returns false for healthy routes", () => {
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);
    });

    it("returns true for open circuits", () => {
      for (let i = 0; i < 10; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(true);
    });

    it("returns false after cooldown period", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      for (let i = 0; i < 10; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(true);

      vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);
    });
  });

  describe("reportSuccess / reportFailure", () => {
    it("opens circuit after exceeding max closed failures", () => {
      for (let i = 0; i < 10; i++) {
        svc.reportFailure("/api/bad", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/bad", "GET")).toBe(true);
    });

    it("resets failure count on success in closed state", () => {
      for (let i = 0; i < 9; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);

      svc.reportSuccess("/api/test", "GET");
      for (let i = 0; i < 9; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);

      svc.reportFailure("/api/test", "GET", 500);
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(true);
    });

    it("closes circuit on success in half_open state", () => {
      for (let i = 0; i < 10; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(true);

      vi.advanceTimersByTime(30_001);
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);

      svc.reportSuccess("/api/test", "GET");
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);
    });

    it("re-opens circuit after half_open failures exceed threshold", () => {
      for (let i = 0; i < 10; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(true);

      vi.advanceTimersByTime(30_001);
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);

      for (let i = 0; i < 3; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(true);
    });
  });

  describe("resetRoute", () => {
    it("resets a specific route", () => {
      for (let i = 0; i < 10; i++) {
        svc.reportFailure("/api/test", "GET", 500);
      }
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(true);

      expect(svc.resetRoute("/api/test", "GET")).toBe(true);
      expect(svc.shouldCircuitBreak("/api/test", "GET")).toBe(false);
    });

    it("returns false for unknown routes", () => {
      expect(svc.resetRoute("/api/unknown", "GET")).toBe(false);
    });
  });

  describe("resetAll", () => {
    it("clears all circuit breaker state", () => {
      for (let i = 0; i < 10; i++) {
        svc.reportFailure("/api/a", "GET", 500);
        svc.reportFailure("/api/b", "POST", 500);
      }

      svc.resetAll();
      expect(svc.shouldCircuitBreak("/api/a", "GET")).toBe(false);
      expect(svc.shouldCircuitBreak("/api/b", "POST")).toBe(false);
    });
  });

  describe("evaluateErrorRates", () => {
    it("trips circuit for routes with error rate above 20% threshold", () => {
      vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
      const route = "/api/eval-high-err-1";
      const method = "GET";

      for (let i = 0; i < 15; i++) {
        perfMonitor.record({ route, method, statusCode: 200, durationMs: 50, timestamp: Date.now() - 30_000 });
      }
      for (let i = 0; i < 5; i++) {
        perfMonitor.record({ route, method, statusCode: 500, durationMs: 50, timestamp: Date.now() - 30_000 });
      }

      expect(svc.shouldCircuitBreak(route, method)).toBe(false);

      svc.evaluateErrorRates(60);

      expect(svc.shouldCircuitBreak(route, method)).toBe(true);
    });

    it("does not trip circuit for routes with error rate below 20% threshold", () => {
      vi.setSystemTime(new Date("2025-06-01T00:01:00Z"));
      const route = "/api/eval-low-err-1";
      const method = "POST";

      for (let i = 0; i < 18; i++) {
        perfMonitor.record({ route, method, statusCode: 200, durationMs: 50, timestamp: Date.now() - 30_000 });
      }
      for (let i = 0; i < 2; i++) {
        perfMonitor.record({ route, method, statusCode: 500, durationMs: 50, timestamp: Date.now() - 30_000 });
      }

      svc.evaluateErrorRates(60);

      expect(svc.shouldCircuitBreak(route, method)).toBe(false);
    });

    it("does not trip already-open circuits", () => {
      vi.setSystemTime(new Date("2025-06-01T00:02:00Z"));
      const route = "/api/eval-already-open-1";
      const method = "GET";

      for (let i = 0; i < 10; i++) {
        svc.reportFailure(route, method, 500);
      }
      expect(svc.shouldCircuitBreak(route, method)).toBe(true);

      for (let i = 0; i < 20; i++) {
        perfMonitor.record({ route, method, statusCode: 500, durationMs: 50, timestamp: Date.now() - 30_000 });
      }

      svc.evaluateErrorRates(60);

      expect(svc.shouldCircuitBreak(route, method)).toBe(true);
    });
  });

  describe("getRouteHealth", () => {
    it("returns route health entries with correct shape", () => {
      vi.setSystemTime(new Date("2025-06-01T00:03:00Z"));
      const health = svc.getRouteHealth();
      expect(Array.isArray(health)).toBe(true);
      if (health.length > 0) {
        const entry = health[0];
        expect(entry).toHaveProperty("route");
        expect(entry).toHaveProperty("method");
        expect(entry).toHaveProperty("circuitState");
        expect(entry).toHaveProperty("errorRate");
        expect(entry).toHaveProperty("errorCount");
        expect(entry).toHaveProperty("totalCount");
        expect(entry).toHaveProperty("consecutiveTrips");
      }
    });

    it("includes routes with recorded failures", () => {
      vi.setSystemTime(new Date("2025-06-01T00:04:00Z"));
      const route = "/api/health-check-route-1";
      const method = "POST";

      for (let i = 0; i < 10; i++) {
        perfMonitor.record({ route, method, statusCode: 500, durationMs: 50, timestamp: Date.now() - 30_000 });
      }

      const result = svc.getRouteHealth(60);
      const match = result.find((r) => r.route === route && r.method === method);
      expect(match).toBeDefined();
      expect(match!.circuitState).toBe("open");
      expect(match!.consecutiveTrips).toBeGreaterThanOrEqual(1);
    });

    it("sorts results by error rate descending", () => {
      vi.setSystemTime(new Date("2025-06-01T00:05:00Z"));
      const highErr = { route: "/api/high-err-sort", method: "GET" };
      const lowErr = { route: "/api/low-err-sort", method: "POST" };

      for (let i = 0; i < 5; i++) {
        perfMonitor.record({ ...highErr, statusCode: 500, durationMs: 50, timestamp: Date.now() - 30_000 });
        perfMonitor.record({ ...highErr, statusCode: 200, durationMs: 50, timestamp: Date.now() - 30_000 });
      }
      for (let i = 0; i < 9; i++) {
        perfMonitor.record({ ...lowErr, statusCode: 200, durationMs: 50, timestamp: Date.now() - 30_000 });
      }
      perfMonitor.record({ ...lowErr, statusCode: 500, durationMs: 50, timestamp: Date.now() - 30_000 });

      const result = svc.getRouteHealth(60);
      const high = result.find((r) => r.route === highErr.route);
      const low = result.find((r) => r.route === lowErr.route);
      expect(high).toBeDefined();
      expect(low).toBeDefined();
      expect(high!.errorRate).toBeGreaterThan(low!.errorRate);
      expect(result.indexOf(high!)).toBeLessThan(result.indexOf(low!));
    });
  });
});
