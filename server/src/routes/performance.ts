import { Router } from "express";
import type { WebVitalReport } from "@paperclipai/shared";
import { perfMonitor, recordWebVitals } from "../middleware/performance-monitor.js";

export function performanceRoutes() {
  const router = Router();

  router.get("/performance/overview", (req, res) => {
    const windowSeconds = req.query.windowSeconds
      ? Number(req.query.windowSeconds)
      : undefined;
    const minRequests = req.query.minRequests
      ? Number(req.query.minRequests)
      : undefined;
    const overview = perfMonitor.overview({ windowSeconds, minRequests });
    res.json(overview);
  });

  router.post("/performance/web-vitals", (req, res) => {
    const report = req.body as WebVitalReport;
    recordWebVitals(report);
    res.json({ ok: true });
  });

  return router;
}
