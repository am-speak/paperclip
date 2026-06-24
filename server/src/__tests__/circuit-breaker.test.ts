import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { circuitBreakerMiddleware } from "../middleware/circuit-breaker.js";
import { autoHeal } from "../services/auto-heal.js";

describe("circuitBreakerMiddleware", () => {
  beforeEach(() => {
    autoHeal.resetAll();
  });

  it("passes through healthy requests", async () => {
    const app = express();
    app.use(circuitBreakerMiddleware());
    app.get("/api/test", (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 503 for open circuits after sufficient failures", async () => {
    const app = express();
    app.use(circuitBreakerMiddleware());
    app.get("/api/fail", (_req, res) => {
      res.status(500).json({ error: "fail" });
    });

    for (let i = 0; i < 10; i++) {
      await request(app).get("/api/fail");
    }

    const res = await request(app).get("/api/fail");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: "Service temporarily unavailable",
      route: "/api/fail",
      method: "GET",
    });
  });

  it("does not circuit-break routes matching skip patterns", async () => {
    const app = express();
    app.use(circuitBreakerMiddleware([/^\/health/]));
    app.get("/health/ping", (_req, res) => {
      res.status(500).json({ error: "fail" });
    });

    for (let i = 0; i < 15; i++) {
      await request(app).get("/health/ping");
    }

    const res = await request(app).get("/health/ping");
    expect(res.status).toBe(500);
  });

  it("recovers after cooldown period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));

    const app = express();
    app.use(circuitBreakerMiddleware());
    app.get("/api/recover", (_req, res) => {
      res.status(500).json({ error: "fail" });
    });

    for (let i = 0; i < 10; i++) {
      await request(app).get("/api/recover");
    }

    let res = await request(app).get("/api/recover");
    expect(res.status).toBe(503);

    vi.setSystemTime(new Date("2025-06-01T00:00:31Z"));

    res = await request(app).get("/api/recover");
    expect(res.status).toBe(500);

    vi.useRealTimers();
  });

  it("tracks distinct circuits per route", async () => {
    const app = express();
    app.use(circuitBreakerMiddleware());
    app.get("/api/healthy", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/api/broken", (_req, res) => {
      res.status(500).json({ error: "fail" });
    });

    for (let i = 0; i < 10; i++) {
      await request(app).get("/api/broken");
    }

    const brokenRes = await request(app).get("/api/broken");
    expect(brokenRes.status).toBe(503);

    const healthyRes = await request(app).get("/api/healthy");
    expect(healthyRes.status).toBe(200);
  });
});
