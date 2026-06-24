import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";
import { autoHeal } from "../services/auto-heal.js";
import { perfMonitor } from "../middleware/performance-monitor.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db));
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable"
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
    });
  });

  describe("GET /health/routes", () => {
    beforeEach(() => {
      autoHeal.resetAll();
    });

    it("returns empty routes list when no data exists", async () => {
      const app = express();
      app.use("/health", healthRoutes());

      const res = await request(app).get("/health/routes");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ routes: [], monitored: 0 });
    });

    it("returns route health data after failures", async () => {
      const app = express();
      app.use("/health", healthRoutes());

      autoHeal.reportFailure("/api/test", "GET", 500);

      const res = await request(app).get("/health/routes");
      expect(res.status).toBe(200);
      expect(res.body.monitored).toBeGreaterThanOrEqual(1);
      const match = res.body.routes.find(
        (r: any) => r.route === "/api/test" && r.method === "GET",
      );
      expect(match).toBeDefined();
      expect(match.circuitState).toBe("closed");
    });

    it("accepts windowSeconds query parameter", async () => {
      const app = express();
      app.use("/health", healthRoutes());

      const res = await request(app).get("/health/routes?windowSeconds=60");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.routes)).toBe(true);
    });

    it("returns open circuit state when circuit is tripped", async () => {
      const app = express();
      app.use("/health", healthRoutes());

      for (let i = 0; i < 10; i++) {
        autoHeal.reportFailure("/api/bad-route", "POST", 500);
      }

      const res = await request(app).get("/health/routes");
      expect(res.status).toBe(200);
      const match = res.body.routes.find(
        (r: any) => r.route === "/api/bad-route" && r.method === "POST",
      );
      expect(match).toBeDefined();
      expect(match.circuitState).toBe("open");
    });
  });

  describe("POST /health/routes/reset", () => {
    beforeEach(() => {
      autoHeal.resetAll();
    });

    function createApp() {
      const app = express();
      app.use(express.json());
      app.use("/health", healthRoutes());
      return app;
    }

    it("resets all routes when no body provided", async () => {
      const app = createApp();

      for (let i = 0; i < 10; i++) {
        autoHeal.reportFailure("/api/a", "GET", 500);
        autoHeal.reportFailure("/api/b", "GET", 500);
      }

      const res = await request(app).post("/health/routes/reset").send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "reset_all" });

      expect(autoHeal.shouldCircuitBreak("/api/a", "GET")).toBe(false);
      expect(autoHeal.shouldCircuitBreak("/api/b", "GET")).toBe(false);
    });

    it("resets a specific route", async () => {
      const app = createApp();

      for (let i = 0; i < 10; i++) {
        autoHeal.reportFailure("/api/specific", "GET", 500);
      }

      const res = await request(app)
        .post("/health/routes/reset")
        .send({ route: "/api/specific", method: "GET" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "reset",
        route: "/api/specific",
        method: "GET",
      });

      expect(autoHeal.shouldCircuitBreak("/api/specific", "GET")).toBe(false);
    });

    it("returns 404 when resetting an unknown route", async () => {
      const app = createApp();

      const res = await request(app)
        .post("/health/routes/reset")
        .send({ route: "/api/unknown", method: "GET" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "route_not_found" });
    });
  });
});
