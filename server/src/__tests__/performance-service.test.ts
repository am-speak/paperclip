import { describe, expect, it, vi } from "vitest";
import { performanceService } from "../services/performance.js";

function observation(overrides: Partial<{
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
}> = {}) {
  return {
    route: "/api/test",
    method: "GET",
    statusCode: 200,
    durationMs: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("performanceService", () => {
  describe("record", () => {
    it("records observations", () => {
      const svc = performanceService();
      svc.record(observation());
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.totalRequests).toBe(1);
    });

    it("trims the buffer when it exceeds MAX_BUFFER", () => {
      const svc = performanceService();
      const many = Array.from({ length: 100_001 }, (_, i) =>
        observation({ route: `/api/route-${i % 100}`, timestamp: Date.now() - 10_000 })
      );
      for (const o of many) svc.record(o);
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.totalRequests).toBe(100_000);
    });
  });

  describe("overview", () => {
    it("returns zeroed overview when no observations exist", () => {
      const svc = performanceService();
      const overview = svc.overview();
      expect(overview).toEqual({
        totalRequests: 0,
        avgResponseMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        errorRate: 0,
        bucketCount: 0,
        windowSeconds: 300,
        buckets: [],
        topSlowRoutes: [],
        topErrorRoutes: [],
        dbQueries: { totalQueries: 0, avgMs: 0, p95Ms: 0, p99Ms: 0, slowQueries: [] },
        webVitals: null,
        webVitalReportCount: 0,
        suggestions: [],
      });
    });

    it("computes correct percentiles and averages", () => {
      const svc = performanceService();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        svc.record(observation({ durationMs: 10 * (i + 1), timestamp: now - 5000 }));
      }
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.totalRequests).toBe(10);
      expect(overview.avgResponseMs).toBe(55);
      expect(overview.p50Ms).toBe(50);
      expect(overview.p95Ms).toBe(100);
      expect(overview.p99Ms).toBe(100);
    });

    it("prunes observations outside the time window", () => {
      const svc = performanceService();
      const now = Date.now();
      svc.record(observation({ timestamp: now - 120_000 }));
      svc.record(observation({ timestamp: now - 10_000 }));
      const overview = svc.overview({ windowSeconds: 30 });
      expect(overview.totalRequests).toBe(1);
    });

    it("groups observations by route+method into buckets", () => {
      const svc = performanceService();
      const now = Date.now();
      svc.record(observation({ route: "/api/a", method: "GET", timestamp: now - 5000 }));
      svc.record(observation({ route: "/api/a", method: "GET", timestamp: now - 4000 }));
      svc.record(observation({ route: "/api/b", method: "POST", timestamp: now - 3000 }));
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.bucketCount).toBe(2);
      expect(overview.buckets.find((b) => b.route === "/api/a")?.count).toBe(2);
      expect(overview.buckets.find((b) => b.route === "/api/b")?.count).toBe(1);
    });

    it("computes error rate correctly", () => {
      const svc = performanceService();
      const now = Date.now();
      for (let i = 0; i < 8; i++) {
        svc.record(observation({ statusCode: 200, timestamp: now - 5000 }));
      }
      for (let i = 0; i < 2; i++) {
        svc.record(observation({ statusCode: 500, timestamp: now - 5000 }));
      }
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.errorRate).toBe(20);
    });

    it("reports top slow routes sorted by p95", () => {
      const svc = performanceService();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        svc.record(observation({ route: "/api/slow", durationMs: 500, timestamp: now - 5000 }));
        svc.record(observation({ route: "/api/fast", durationMs: 10, timestamp: now - 5000 }));
      }
      const overview = svc.overview({ windowSeconds: 60, minRequests: 5 });
      expect(overview.topSlowRoutes.length).toBeGreaterThanOrEqual(1);
      expect(overview.topSlowRoutes[0].route).toBe("/api/slow");
    });

    it("reports top error routes with correct error rates", () => {
      const svc = performanceService();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        svc.record(observation({ route: "/api/erratic", statusCode: i < 4 ? 500 : 200, timestamp: now - 5000 }));
        svc.record(observation({ route: "/api/healthy", statusCode: 200, timestamp: now - 5000 }));
      }
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.topErrorRoutes.length).toBe(1);
      expect(overview.topErrorRoutes[0].route).toBe("/api/erratic");
      expect(overview.topErrorRoutes[0].errorRate).toBe(40);
      expect(overview.topErrorRoutes[0].errorCount).toBe(4);
      expect(overview.topErrorRoutes[0].totalCount).toBe(10);
    });

    it("filters slow routes below minRequests threshold", () => {
      const svc = performanceService();
      const now = Date.now();
      svc.record(observation({ route: "/api/rare", durationMs: 9999, timestamp: now - 5000 }));
      const overview = svc.overview({ windowSeconds: 60, minRequests: 5 });
      expect(overview.topSlowRoutes.find((r) => r.route === "/api/rare")).toBeUndefined();
    });

    it("uses default window of 300s when not configured", () => {
      const svc = performanceService();
      const now = Date.now();
      svc.record(observation({ timestamp: now - 10_000 }));
      const overview = svc.overview();
      expect(overview.windowSeconds).toBe(300);
    });
  });

  describe("web vitals aggregation", () => {
    it("returns null and count 0 when no web vitals recorded", () => {
      const svc = performanceService();
      const overview = svc.overview();
      expect(overview.webVitals).toBeNull();
      expect(overview.webVitalReportCount).toBe(0);
    });

    it("aggregates multiple web vital reports with averages", () => {
      const svc = performanceService();
      svc.recordWebVitals({ lcp: 2000, cls: 0.1, inp: 150, fcp: 800, ttfb: 300, reportedAt: Date.now() - 5000 });
      svc.recordWebVitals({ lcp: 4000, cls: 0.3, inp: 350, fcp: 1200, ttfb: 600, reportedAt: Date.now() - 3000 });
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.webVitals).not.toBeNull();
      expect(overview.webVitals!.lcp).toBe(3000);
      expect(overview.webVitals!.cls).toBeCloseTo(0.2);
      expect(overview.webVitals!.inp).toBe(250);
      expect(overview.webVitals!.fcp).toBe(1000);
      expect(overview.webVitals!.ttfb).toBe(450);
      expect(overview.webVitalReportCount).toBe(2);
    });

    it("prunes web vital reports outside the time window", () => {
      const svc = performanceService();
      svc.recordWebVitals({ lcp: 1000, reportedAt: Date.now() - 120_000 });
      svc.recordWebVitals({ lcp: 3000, reportedAt: Date.now() - 10_000 });
      const overview = svc.overview({ windowSeconds: 30 });
      expect(overview.webVitalReportCount).toBe(1);
      expect(overview.webVitals!.lcp).toBe(3000);
    });

    it("handles partial reports gracefully", () => {
      const svc = performanceService();
      svc.recordWebVitals({ lcp: 2500, reportedAt: Date.now() - 5000 });
      svc.recordWebVitals({ cls: 0.15, inp: 200, reportedAt: Date.now() - 3000 });
      const overview = svc.overview({ windowSeconds: 60 });
      expect(overview.webVitalReportCount).toBe(2);
      expect(overview.webVitals!.lcp).toBe(2500);
      expect(overview.webVitals!.cls).toBeCloseTo(0.15);
      expect(overview.webVitals!.inp).toBe(200);
    });
  });
});
