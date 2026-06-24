export interface PerformanceMetricBucket {
  route: string;
  method: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  lastSeenAt: string;
}

export interface DbQueryBucket {
  query: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
  lastSeenAt: string;
}

export interface DbQueryOverview {
  totalQueries: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  slowQueries: DbQueryBucket[];
}

export interface WebVitalReport {
  lcp?: number;
  cls?: number;
  inp?: number;
  fcp?: number;
  ttfb?: number;
  reportedAt: number;
}

export interface OptimizationSuggestion {
  type: "slow_api" | "slow_query" | "web_vital" | "error_rate";
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  route?: string;
  metric?: string;
  currentValue?: string;
  suggestion: string;
}

export interface PerformanceOverview {
  totalRequests: number;
  avgResponseMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
  bucketCount: number;
  windowSeconds: number;
  buckets: PerformanceMetricBucket[];
  topSlowRoutes: { route: string; method: string; avgMs: number; count: number }[];
  topErrorRoutes: { route: string; method: string; errorCount: number; totalCount: number; errorRate: number }[];
  dbQueries: DbQueryOverview;
  webVitals: WebVitalReport | null;
  suggestions: OptimizationSuggestion[];
}

export interface PerformanceWindowConfig {
  windowSeconds?: number;
  minRequests?: number;
}
