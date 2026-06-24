import type { DbQueryBucket, DbQueryOverview, OptimizationSuggestion, PerformanceMetricBucket, PerformanceOverview, PerformanceWindowConfig, WebVitalReport } from "@paperclipai/shared";

export interface PerformanceServiceOptions {
  defaultWindowSeconds?: number;
  defaultMinRequests?: number;
  maxBuffer?: number;
  maxDbBuffer?: number;
  slowQueryThresholdMs?: number;
}

export interface RawObservation {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
}

export interface DbQueryObservation {
  query: string;
  durationMs: number;
  timestamp: number;
}

export function performanceService(opts?: PerformanceServiceOptions) {
  let defaultWindowSeconds = opts?.defaultWindowSeconds ?? 300;
  let defaultMinRequests = opts?.defaultMinRequests ?? 5;
  let maxBuffer = opts?.maxBuffer ?? 100_000;
  let maxDbBuffer = opts?.maxDbBuffer ?? 10_000;
  let slowQueryThresholdMs = opts?.slowQueryThresholdMs ?? 100;
  const buffer: RawObservation[] = [];
  const dbBuffer: DbQueryObservation[] = [];
  let webVitals: WebVitalReport[] = [];

  function record(observation: RawObservation): void {
    buffer.push(observation);
    if (buffer.length > maxBuffer) {
      buffer.splice(0, buffer.length - maxBuffer);
    }
  }

  function recordDbQuery(observation: DbQueryObservation): void {
    dbBuffer.push(observation);
    if (dbBuffer.length > maxDbBuffer) {
      dbBuffer.splice(0, dbBuffer.length - maxDbBuffer);
    }
  }

  function recordWebVitals(report: WebVitalReport): void {
    webVitals.push(report);
    if (webVitals.length > maxBuffer) {
      webVitals.splice(0, webVitals.length - maxBuffer);
    }
  }

  function prune(now: number, windowSeconds: number): void {
    const cutoff = now - windowSeconds * 1000;
    let firstAlive = 0;
    while (firstAlive < buffer.length && buffer[firstAlive].timestamp < cutoff) {
      firstAlive++;
    }
    if (firstAlive > 0) {
      buffer.splice(0, firstAlive);
    }

    let firstDbAlive = 0;
    while (firstDbAlive < dbBuffer.length && dbBuffer[firstDbAlive].timestamp < cutoff) {
      firstDbAlive++;
    }
    if (firstDbAlive > 0) {
      dbBuffer.splice(0, firstDbAlive);
    }

    let firstWvAlive = 0;
    while (firstWvAlive < webVitals.length && webVitals[firstWvAlive].reportedAt < cutoff) {
      firstWvAlive++;
    }
    if (firstWvAlive > 0) {
      webVitals.splice(0, firstWvAlive);
    }
  }

  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  function buildSuggestions(data: {
    totalRequests: number;
    errorRate: number;
    buckets: PerformanceMetricBucket[];
    topSlowRoutes: { route: string; method: string; avgMs: number; count: number }[];
    topErrorRoutes: { route: string; method: string; errorCount: number; totalCount: number; errorRate: number }[];
    dbQueries: DbQueryOverview;
    webVitalsReport: WebVitalReport | null;
  }): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    for (const route of data.topSlowRoutes) {
      if (route.avgMs > 2000) {
        suggestions.push({
          type: "slow_api",
          severity: "critical",
          title: `Slow API: ${route.method} ${route.route}`,
          description: `Average response time of ${route.avgMs}ms across ${route.count} calls`,
          route: `${route.method} ${route.route}`,
          metric: "avgMs",
          currentValue: `${route.avgMs}ms`,
          suggestion: "Consider adding caching or optimizing the endpoint logic. If data-fetching, add DB indexes or use connection pooling.",
        });
      } else if (route.avgMs > 500) {
        suggestions.push({
          type: "slow_api",
          severity: "warning",
          title: `Slow API: ${route.method} ${route.route}`,
          description: `Average response time of ${route.avgMs}ms across ${route.count} calls`,
          route: `${route.method} ${route.route}`,
          metric: "avgMs",
          currentValue: `${route.avgMs}ms`,
          suggestion: "Review endpoint logic and database queries used by this route.",
        });
      }
    }

    for (const route of data.topErrorRoutes) {
      if (route.errorRate > 10) {
        suggestions.push({
          type: "error_rate",
          severity: "critical",
          title: `High error rate: ${route.method} ${route.route}`,
          description: `${route.errorRate}% error rate (${route.errorCount}/${route.totalCount} requests)`,
          route: `${route.method} ${route.route}`,
          metric: "errorRate",
          currentValue: `${route.errorRate}%`,
          suggestion: "Investigate server-side errors. Check for unhandled exceptions, database connection issues, or validation failures.",
        });
      } else if (route.errorRate > 3) {
        suggestions.push({
          type: "error_rate",
          severity: "warning",
          title: `Elevated error rate: ${route.method} ${route.route}`,
          description: `${route.errorRate}% error rate (${route.errorCount}/${route.totalCount} requests)`,
          route: `${route.method} ${route.route}`,
          metric: "errorRate",
          currentValue: `${route.errorRate}%`,
          suggestion: "Monitor this route for intermittent failures. Review error logs for patterns.",
        });
      }
    }

    for (const q of data.dbQueries.slowQueries) {
      if (q.avgMs > 500) {
        suggestions.push({
          type: "slow_query",
          severity: "critical",
          title: "Slow database query",
          description: `Average ${q.avgMs}ms across ${q.count} executions (p95: ${q.p95Ms}ms)`,
          metric: "queryAvgMs",
          currentValue: `${q.avgMs}ms`,
          suggestion: "Add database indexes for the tables involved. Consider adding `EXPLAIN ANALYZE` to identify full table scans. Simplify joins and subqueries.",
        });
      } else if (q.avgMs > 100) {
        suggestions.push({
          type: "slow_query",
          severity: "warning",
          title: "Moderately slow database query",
          description: `Average ${q.avgMs}ms across ${q.count} executions (p95: ${q.p95Ms}ms)`,
          metric: "queryAvgMs",
          currentValue: `${q.avgMs}ms`,
          suggestion: "Review query patterns and consider adding indexes for filtered columns.",
        });
      }
    }

    if (data.webVitalsReport) {
      const wv = data.webVitalsReport;
      if (wv.lcp && wv.lcp > 4000) {
        suggestions.push({
          type: "web_vital",
          severity: "critical",
          title: "Poor LCP (Largest Contentful Paint)",
          description: `LCP is ${Math.round(wv.lcp)}ms, exceeding the 2.5s good threshold`,
          metric: "lcp",
          currentValue: `${Math.round(wv.lcp)}ms`,
          suggestion: "Optimize the largest content element: lazy-load below-fold images, use proper image dimensions, preconnect to origins, and minimize render-blocking resources.",
        });
      } else if (wv.lcp && wv.lcp > 2500) {
        suggestions.push({
          type: "web_vital",
          severity: "warning",
          title: "Needs improvement: LCP",
          description: `LCP is ${Math.round(wv.lcp)}ms (good threshold is <2.5s)`,
          metric: "lcp",
          currentValue: `${Math.round(wv.lcp)}ms`,
          suggestion: "Improve server response time, optimize images, and eliminate render-blocking resources.",
        });
      }

      if (wv.cls !== undefined && wv.cls > 0.25) {
        suggestions.push({
          type: "web_vital",
          severity: "warning",
          title: "Poor CLS (Cumulative Layout Shift)",
          description: `CLS is ${wv.cls.toFixed(3)} (good threshold is <0.1)`,
          metric: "cls",
          currentValue: wv.cls.toFixed(3),
          suggestion: "Ensure all images and embeds have explicit width/height attributes. Avoid injecting content above existing content.",
        });
      }

      if (wv.inp && wv.inp > 500) {
        suggestions.push({
          type: "web_vital",
          severity: "warning",
          title: "Poor INP (Interaction to Next Paint)",
          description: `INP is ${Math.round(wv.inp)}ms (good threshold is <200ms)`,
          metric: "inp",
          currentValue: `${Math.round(wv.inp)}ms`,
          suggestion: "Break up long tasks, debounce expensive event handlers, use web workers for heavy computation.",
        });
      }
    }

    suggestions.sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    return suggestions.slice(0, 20);
  }

  function overview(config?: PerformanceWindowConfig): PerformanceOverview {
    const now = Date.now();
    const windowSeconds = config?.windowSeconds ?? defaultWindowSeconds;
    const minRequests = config?.minRequests ?? defaultMinRequests;
    prune(now, windowSeconds);

    const emptyOverview = {
      totalRequests: 0,
      avgResponseMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      errorRate: 0,
      bucketCount: 0,
      windowSeconds,
      buckets: [] as PerformanceMetricBucket[],
      topSlowRoutes: [] as { route: string; method: string; avgMs: number; count: number }[],
      topErrorRoutes: [] as { route: string; method: string; errorCount: number; totalCount: number; errorRate: number }[],
      dbQueries: buildDbQueryOverview([]),
      webVitals: null as WebVitalReport | null,
      webVitalReportCount: 0,
      suggestions: [] as OptimizationSuggestion[],
    };

    if (buffer.length === 0) {
      emptyOverview.dbQueries = buildDbQueryOverview(dbBuffer);
      const agg = aggregateWebVitals(webVitals);
      emptyOverview.webVitals = agg.report;
      emptyOverview.webVitalReportCount = agg.count;
      emptyOverview.suggestions = buildSuggestions({
        totalRequests: 0, errorRate: 0, buckets: [],
        topSlowRoutes: [], topErrorRoutes: [],
        dbQueries: emptyOverview.dbQueries, webVitalsReport: agg.report,
      });
      return emptyOverview;
    }

    const allDurations = buffer.map((o) => o.durationMs).sort((a, b) => a - b);

    const grouped = new Map<string, RawObservation[]>();
    for (const obs of buffer) {
      const key = `${obs.method} ${obs.route}`;
      let group = grouped.get(key);
      if (!group) {
        group = [];
        grouped.set(key, group);
      }
      group.push(obs);
    }

    const buckets: PerformanceMetricBucket[] = [];
    for (const [key, group] of grouped) {
      const durations = group.map((o) => o.durationMs).sort((a, b) => a - b);
      const spaceIdx = key.indexOf(" ");
      const method = key.slice(0, spaceIdx);
      const route = key.slice(spaceIdx + 1);
      const lastSeen = Math.max(...group.map((o) => o.timestamp));
      buckets.push({
        route,
        method,
        count: group.length,
        totalMs: durations.reduce((s, v) => s + v, 0),
        minMs: durations[0],
        maxMs: durations[durations.length - 1],
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        p99Ms: percentile(durations, 99),
        lastSeenAt: new Date(lastSeen).toISOString(),
      });
    }

    const totalRequests = buffer.length;
    const totalMs = allDurations.reduce((s, v) => s + v, 0);
    const errorCount = buffer.filter((o) => o.statusCode >= 400).length;

    const topSlowRoutes = buckets
      .filter((b) => b.count >= minRequests)
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 10)
      .map((b) => ({ route: b.route, method: b.method, avgMs: Math.round(b.totalMs / b.count), count: b.count }));

    const topErrorRoutes: { route: string; method: string; errorCount: number; totalCount: number; errorRate: number }[] = [];
    for (const [key, group] of grouped) {
      const spaceIdx = key.indexOf(" ");
      const method = key.slice(0, spaceIdx);
      const route = key.slice(spaceIdx + 1);
      const errCount = group.filter((o) => o.statusCode >= 400).length;
      if (errCount > 0) {
        topErrorRoutes.push({
          route,
          method,
          errorCount: errCount,
          totalCount: group.length,
          errorRate: Math.round((errCount / group.length) * 10000) / 100,
        });
      }
    }
    topErrorRoutes.sort((a, b) => b.errorRate - a.errorRate);

    const dbQueries = buildDbQueryOverview(dbBuffer);
    const agg = aggregateWebVitals(webVitals);

    const overviewResult: PerformanceOverview = {
      totalRequests,
      avgResponseMs: Math.round(totalMs / totalRequests),
      p50Ms: percentile(allDurations, 50),
      p95Ms: percentile(allDurations, 95),
      p99Ms: percentile(allDurations, 99),
      errorRate: Math.round((errorCount / totalRequests) * 10000) / 100,
      bucketCount: buckets.length,
      windowSeconds,
      buckets,
      topSlowRoutes,
      topErrorRoutes: topErrorRoutes.slice(0, 10),
      dbQueries,
      webVitals: agg.report,
      webVitalReportCount: agg.count,
      suggestions: [],
    };

    overviewResult.suggestions = buildSuggestions({
      totalRequests: overviewResult.totalRequests,
      errorRate: overviewResult.errorRate,
      buckets,
      topSlowRoutes,
      topErrorRoutes: overviewResult.topErrorRoutes,
      dbQueries,
      webVitalsReport: agg.report,
    });

    return overviewResult;
  }

  function aggregateWebVitals(reports: WebVitalReport[]): { report: WebVitalReport | null; count: number } {
    if (reports.length === 0) return { report: null, count: 0 };

    let lcpSum = 0; let lcpCount = 0;
    let clsSum = 0; let clsCount = 0;
    let inpSum = 0; let inpCount = 0;
    let fcpSum = 0; let fcpCount = 0;
    let ttfbSum = 0; let ttfbCount = 0;
    let latestTs = 0;

    for (const r of reports) {
      if (r.lcp !== undefined) { lcpSum += r.lcp; lcpCount++; }
      if (r.cls !== undefined) { clsSum += r.cls; clsCount++; }
      if (r.inp !== undefined) { inpSum += r.inp; inpCount++; }
      if (r.fcp !== undefined) { fcpSum += r.fcp; fcpCount++; }
      if (r.ttfb !== undefined) { ttfbSum += r.ttfb; ttfbCount++; }
      if (r.reportedAt > latestTs) latestTs = r.reportedAt;
    }

    const report: WebVitalReport = { reportedAt: latestTs };
    if (lcpCount > 0) report.lcp = Math.round(lcpSum / lcpCount);
    if (clsCount > 0) report.cls = clsSum / clsCount;
    if (inpCount > 0) report.inp = Math.round(inpSum / inpCount);
    if (fcpCount > 0) report.fcp = Math.round(fcpSum / fcpCount);
    if (ttfbCount > 0) report.ttfb = Math.round(ttfbSum / ttfbCount);

    return { report, count: reports.length };
  }

  function buildDbQueryOverview(observations: DbQueryObservation[]): DbQueryOverview {
    if (observations.length === 0) {
      return { totalQueries: 0, avgMs: 0, p95Ms: 0, p99Ms: 0, slowQueries: [] };
    }

    const allDurations = observations.map((o) => o.durationMs).sort((a, b) => a - b);

    const grouped = new Map<string, { durations: number[]; lastSeen: number }>();
    for (const obs of observations) {
      const existing = grouped.get(obs.query);
      if (existing) {
        existing.durations.push(obs.durationMs);
        if (obs.timestamp > existing.lastSeen) existing.lastSeen = obs.timestamp;
      } else {
        grouped.set(obs.query, { durations: [obs.durationMs], lastSeen: obs.timestamp });
      }
    }

    const slowQueries: DbQueryBucket[] = [];
    for (const [query, data] of grouped) {
      const sorted = data.durations.sort((a, b) => a - b);
      const totalMs = sorted.reduce((s, v) => s + v, 0);
      const avgMs = Math.round(totalMs / sorted.length);
      if (avgMs >= slowQueryThresholdMs) {
        slowQueries.push({
          query: query.length > 200 ? query.slice(0, 200) + "..." : query,
          count: sorted.length,
          totalMs,
          minMs: sorted[0],
          maxMs: sorted[sorted.length - 1],
          avgMs,
          p95Ms: percentile(sorted, 95),
          lastSeenAt: new Date(data.lastSeen).toISOString(),
        });
      }
    }
    slowQueries.sort((a, b) => b.avgMs - a.avgMs);

    return {
      totalQueries: observations.length,
      avgMs: Math.round(allDurations.reduce((s, v) => s + v, 0) / allDurations.length),
      p95Ms: percentile(allDurations, 95),
      p99Ms: percentile(allDurations, 99),
      slowQueries: slowQueries.slice(0, 20),
    };
  }

  function configure(opts: PerformanceServiceOptions): void {
    if (opts.defaultWindowSeconds !== undefined) defaultWindowSeconds = opts.defaultWindowSeconds;
    if (opts.defaultMinRequests !== undefined) defaultMinRequests = opts.defaultMinRequests;
    if (opts.maxBuffer !== undefined) maxBuffer = opts.maxBuffer;
    if (opts.maxDbBuffer !== undefined) maxDbBuffer = opts.maxDbBuffer;
    if (opts.slowQueryThresholdMs !== undefined) slowQueryThresholdMs = opts.slowQueryThresholdMs;
  }

  return { record, recordDbQuery, recordWebVitals, overview, configure };
}
