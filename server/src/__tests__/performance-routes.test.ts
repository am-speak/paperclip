import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { perfMonitor } from "../middleware/performance-monitor.js";
import { performanceRoutes } from "../routes/performance.js";
import "./setup-supertest.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", performanceRoutes());
  return app;
}

describe("GET /api/performance/overview", () => {
  beforeEach(() => {
    const now = Date.now();
    perfMonitor.record({ route: "/api/test", method: "GET", statusCode: 200, durationMs: 50, timestamp: now - 5000 });
    perfMonitor.record({ route: "/api/test", method: "GET", statusCode: 200, durationMs: 150, timestamp: now - 4000 });
    perfMonitor.record({ route: "/api/slow", method: "POST", statusCode: 200, durationMs: 2500, timestamp: now - 3000 });
    perfMonitor.record({ route: "/api/error", method: "GET", statusCode: 500, durationMs: 30, timestamp: now - 2000 });
  });

  it("returns 200 with overview shape", async () => {
    const app = createApp();
    const res = await request(app).get("/api/performance/overview");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalRequests");
    expect(res.body).toHaveProperty("avgResponseMs");
    expect(res.body).toHaveProperty("p50Ms");
    expect(res.body).toHaveProperty("p95Ms");
    expect(res.body).toHaveProperty("p99Ms");
    expect(res.body).toHaveProperty("errorRate");
    expect(res.body).toHaveProperty("buckets");
    expect(res.body).toHaveProperty("suggestions");
    expect(res.body).toHaveProperty("dbQueries");
  });

  it("accepts windowSeconds query param", async () => {
    const app = createApp();
    const res = await request(app).get("/api/performance/overview?windowSeconds=60");
    expect(res.status).toBe(200);
    expect(res.body.windowSeconds).toBe(60);
  });

  it("accepts minRequests query param", async () => {
    const app = createApp();
    const res = await request(app).get("/api/performance/overview?minRequests=10");
    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBeGreaterThan(0);
  });
});

describe("POST /api/performance/web-vitals", () => {
  it("returns 200 with ok", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/performance/web-vitals")
      .send({ lcp: 2500, cls: 0.05, reportedAt: Date.now() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
