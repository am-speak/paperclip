import type { WebVitalReport } from "@paperclipai/shared";
import { api } from "../api/client";

function sendWebVitals(report: WebVitalReport) {
  api.post("/performance/web-vitals", report).catch(() => {
    // silently ignore — telemetry is best-effort
  });
}

let reported = false;

function roundMs(value: number): number {
  return Math.round(value);
}

export function initWebVitals(): void {
  if (reported) return;
  reported = true;

  const report: WebVitalReport = { reportedAt: Date.now() };

  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        report.lcp = roundMs(lastEntry.startTime);
      }
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    // LCP not supported
  }

  try {
    let clsValue = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry as any).hadRecentInput) {
          clsValue += (entry as any).value;
        }
      }
      report.cls = clsValue;
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
  } catch {
    // CLS not supported
  }

  try {
    const inpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (const entry of entries) {
        report.inp = roundMs(entry.duration);
      }
    });
    inpObserver.observe({ type: "first-input", buffered: true });
    inpObserver.observe({ type: "event", buffered: true, durationThreshold: 0 });
  } catch {
    // INP not supported
  }

  try {
    const paintObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") {
          report.fcp = roundMs(entry.startTime);
        }
      }
    });
    paintObserver.observe({ type: "paint", buffered: true });
  } catch {
    // Paint timing not supported
  }

  try {
    const navEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navEntry) {
      report.ttfb = roundMs(navEntry.responseStart - navEntry.requestStart);
    }
  } catch {
    // Navigation timing not supported
  }

  const timer = setTimeout(() => {
    report.reportedAt = Date.now();
    sendWebVitals(report);
  }, 5000);

  // Also report on page unload if the browser supports sendBeacon
  if (navigator.sendBeacon) {
    window.addEventListener("beforeunload", () => {
      clearTimeout(timer);
      report.reportedAt = Date.now();
      navigator.sendBeacon(
        "/api/performance/web-vitals",
        new Blob([JSON.stringify(report)], { type: "application/json" }),
      );
    });
  }
}
