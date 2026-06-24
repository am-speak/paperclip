import { api } from "./client";
import type { PerformanceOverview, PerformanceWindowConfig, WebVitalReport } from "@paperclipai/shared";

function buildQuery(config?: PerformanceWindowConfig): string {
  if (!config) return "";
  const params = new URLSearchParams();
  if (config.windowSeconds) params.set("windowSeconds", String(config.windowSeconds));
  if (config.minRequests) params.set("minRequests", String(config.minRequests));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const performanceApi = {
  overview: (config?: PerformanceWindowConfig): Promise<PerformanceOverview> =>
    api.get(`/performance/overview${buildQuery(config)}`),
  reportWebVitals: (report: WebVitalReport): Promise<{ ok: boolean }> =>
    api.post("/performance/web-vitals", report),
};
