import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { performanceApi } from "../api/performance";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Gauge, Route, AlertTriangle, Clock, TrendingUp, Database, Lightbulb, MousePointer2 } from "lucide-react";
import type { PerformanceOverview, OptimizationSuggestion } from "@paperclipai/shared";

const POLL_INTERVAL = 10_000;

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toLocaleString()}ms`;
}

function MetricCard({
  label,
  value,
  subtitle,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "warning" | "danger";
}) {
  const toneStyles = {
    default: "text-muted-foreground",
    warning: "text-amber-500",
    danger: "text-red-500",
  };
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <Icon className={`h-4 w-4 ${toneStyles[tone ?? "default"]}`} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}

function StatBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-10 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs font-mono w-20 text-right">{formatMs(value)}</span>
    </div>
  );
}

function SlowRoutesCard({ overview }: { overview: PerformanceOverview }) {
  if (overview.topSlowRoutes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Slowest Routes
          </CardTitle>
          <CardDescription>Routes with the highest p95 latency</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Insufficient data yet — keep using the app.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Slowest Routes
        </CardTitle>
        <CardDescription>Routes with the highest p95 latency</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {overview.topSlowRoutes.map((route) => (
            <div key={`${route.method} ${route.route}`} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className="font-mono text-xs shrink-0">{route.method}</Badge>
                <span className="truncate font-mono text-xs">{route.route}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-muted-foreground">{route.count} calls</span>
                <span className="font-mono text-xs font-medium">{formatMs(route.avgMs)}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorRoutesCard({ overview }: { overview: PerformanceOverview }) {
  if (overview.topErrorRoutes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Error-Prone Routes
          </CardTitle>
          <CardDescription>Routes with the highest error rate</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No errors observed in the current window.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Error-Prone Routes
        </CardTitle>
        <CardDescription>Routes with the highest error rate</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {overview.topErrorRoutes.map((route) => (
            <div key={`${route.method} ${route.route}`} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className="font-mono text-xs shrink-0">{route.method}</Badge>
                <span className="truncate font-mono text-xs">{route.route}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-muted-foreground">{route.errorCount}/{route.totalCount}</span>
                <span className="font-mono text-xs font-medium text-red-500">{route.errorRate}%</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DbQueriesCard({ overview }: { overview: PerformanceOverview }) {
  const db = overview.dbQueries;
  if (db.totalQueries === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4" />
            Database Queries
          </CardTitle>
          <CardDescription>Query performance monitoring</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No queries observed yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Database className="h-4 w-4" />
          Database Queries
        </CardTitle>
        <CardDescription>{db.totalQueries.toLocaleString()} queries · avg {formatMs(db.avgMs)} · p95 {formatMs(db.p95Ms)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex gap-4 text-xs text-muted-foreground">
          <span>Total: {db.totalQueries.toLocaleString()}</span>
          <span>Avg: {formatMs(db.avgMs)}</span>
          <span>p95: {formatMs(db.p95Ms)}</span>
          <span>p99: {formatMs(db.p99Ms)}</span>
        </div>
        {db.slowQueries.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Slow Queries (&gt;100ms avg)</p>
            {db.slowQueries.map((q, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="truncate font-mono text-xs flex-1 min-w-0 mr-2">{q.query}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted-foreground">{q.count}x</span>
                  <span className="font-mono text-xs font-medium">{formatMs(q.avgMs)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WebVitalCard({ overview }: { overview: PerformanceOverview }) {
  const wv = overview.webVitals;
  if (!wv) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <MousePointer2 className="h-4 w-4" />
            Core Web Vitals
          </CardTitle>
          <CardDescription>LCP / CLS / INP from real user sessions</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Waiting for the next page load to report vitals.</p>
        </CardContent>
      </Card>
    );
  }

  const lcpTone = wv.lcp && wv.lcp > 4000 ? "danger" : wv.lcp && wv.lcp > 2500 ? "warning" : "default";
  const clsTone = wv.cls !== undefined && wv.cls > 0.25 ? "danger" : wv.cls !== undefined && wv.cls > 0.1 ? "warning" : "default";
  const inpTone = wv.inp && wv.inp > 500 ? "danger" : wv.inp && wv.inp > 200 ? "warning" : "default";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <MousePointer2 className="h-4 w-4" />
          Core Web Vitals
        </CardTitle>
        <CardDescription>Average from {overview.webVitalReportCount} page load{overview.webVitalReportCount !== 1 ? 's' : ''}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {wv.lcp !== undefined && (
            <div>
              <p className={`text-xs font-medium ${lcpTone === "danger" ? "text-red-500" : lcpTone === "warning" ? "text-amber-500" : "text-muted-foreground"}`}>LCP</p>
              <p className="text-lg font-bold font-mono">{formatMs(wv.lcp)}</p>
              <p className="text-[10px] text-muted-foreground">Largest Contentful Paint</p>
            </div>
          )}
          {wv.cls !== undefined && (
            <div>
              <p className={`text-xs font-medium ${clsTone === "danger" ? "text-red-500" : clsTone === "warning" ? "text-amber-500" : "text-muted-foreground"}`}>CLS</p>
              <p className="text-lg font-bold font-mono">{wv.cls.toFixed(3)}</p>
              <p className="text-[10px] text-muted-foreground">Cumulative Layout Shift</p>
            </div>
          )}
          {wv.inp !== undefined && (
            <div>
              <p className={`text-xs font-medium ${inpTone === "danger" ? "text-red-500" : inpTone === "warning" ? "text-amber-500" : "text-muted-foreground"}`}>INP</p>
              <p className="text-lg font-bold font-mono">{formatMs(wv.inp)}</p>
              <p className="text-[10px] text-muted-foreground">Interaction to Next Paint</p>
            </div>
          )}
          {wv.fcp !== undefined && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">FCP</p>
              <p className="text-lg font-bold font-mono">{formatMs(wv.fcp)}</p>
              <p className="text-[10px] text-muted-foreground">First Contentful Paint</p>
            </div>
          )}
          {wv.ttfb !== undefined && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">TTFB</p>
              <p className="text-lg font-bold font-mono">{formatMs(wv.ttfb)}</p>
              <p className="text-[10px] text-muted-foreground">Time to First Byte</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SuggestionBadge({ severity }: { severity: OptimizationSuggestion["severity"] }) {
  const styles = {
    critical: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    info: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  };
  return (
    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${styles[severity]}`}>
      {severity}
    </span>
  );
}

function TypeIcon({ type }: { type: OptimizationSuggestion["type"] }) {
  const icons = {
    slow_api: TrendingUp,
    slow_query: Database,
    web_vital: MousePointer2,
    error_rate: AlertTriangle,
  };
  const Icon = icons[type];
  return <Icon className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />;
}

function SuggestionsCard({ overview }: { overview: PerformanceOverview }) {
  if (overview.suggestions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Lightbulb className="h-4 w-4" />
            Optimization Suggestions
          </CardTitle>
          <CardDescription>Automated performance recommendations</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No suggestions yet — the system looks healthy.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Lightbulb className="h-4 w-4" />
          Optimization Suggestions
        </CardTitle>
        <CardDescription>Automated recommendations based on current metrics</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {overview.suggestions.map((s, i) => (
            <div key={i} className="flex gap-3">
              <TypeIcon type={s.type} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <SuggestionBadge severity={s.severity} />
                  <span className="text-sm font-medium">{s.title}</span>
                </div>
                <p className="text-xs text-muted-foreground mb-1">{s.description}</p>
                <p className="text-xs">{s.suggestion}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function Performance() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [windowSeconds, setWindowSeconds] = useState(300);

  useEffect(() => {
    setBreadcrumbs([{ label: "Performance" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["performance", "overview", windowSeconds],
    queryFn: () => performanceApi.overview({ windowSeconds }),
    refetchInterval: POLL_INTERVAL,
  });

  if (isLoading) return <PageSkeleton />;

  if (error) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Card>
          <CardHeader>
            <CardTitle>Performance Data Unavailable</CardTitle>
            <CardDescription>
              The performance monitoring endpoint could not be reached. This is expected if the server was
              started before this feature was added — restart the server to begin collecting metrics.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const overview = data as PerformanceOverview;
  const isEmpty = overview.totalRequests === 0;

  return (
    <div className="mx-auto max-w-5xl py-6 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API Performance</h1>
          <p className="text-sm text-muted-foreground">
            Real-time API response time monitoring
            {overview.totalRequests > 0 && ` — last ${overview.windowSeconds}s`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWindowSeconds(60)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              windowSeconds === 60 ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
            }`}
          >
            1m
          </button>
          <button
            onClick={() => setWindowSeconds(300)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              windowSeconds === 300 ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
            }`}
          >
            5m
          </button>
          <button
            onClick={() => setWindowSeconds(1800)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              windowSeconds === 1800 ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
            }`}
          >
            30m
          </button>
        </div>
      </div>

      {isEmpty ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Waiting for data
            </CardTitle>
            <CardDescription>
              No API requests have been observed yet. Start using the application and metrics will
              appear here automatically.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Total Requests"
              value={overview.totalRequests.toLocaleString()}
              subtitle={`in the last ${overview.windowSeconds}s window`}
              icon={Activity}
            />
            <MetricCard
              label="Avg Response"
              value={formatMs(overview.avgResponseMs)}
              subtitle={`p50: ${formatMs(overview.p50Ms)} · p95: ${formatMs(overview.p95Ms)} · p99: ${formatMs(overview.p99Ms)}`}
              icon={Gauge}
              tone={overview.p95Ms > 1000 ? "warning" : overview.p95Ms > 3000 ? "danger" : "default"}
            />
            <MetricCard
              label="Error Rate"
              value={`${overview.errorRate}%`}
              subtitle={`of ${overview.totalRequests} requests`}
              icon={AlertTriangle}
              tone={overview.errorRate > 5 ? "danger" : overview.errorRate > 1 ? "warning" : "default"}
            />
            <MetricCard
              label="Routes Tracked"
              value={String(overview.bucketCount)}
              subtitle="unique route+method combinations"
              icon={Route}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Latency Percentiles
              </CardTitle>
              <CardDescription>
                Distribution of API response times across all routes
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <StatBar label="p50" value={overview.p50Ms} max={Math.max(overview.p99Ms, 1)} />
                <StatBar label="p95" value={overview.p95Ms} max={Math.max(overview.p99Ms, 1)} />
                <StatBar label="p99" value={overview.p99Ms} max={Math.max(overview.p99Ms, 1)} />
                <StatBar label="max" value={Math.max(...overview.buckets.map((b) => b.maxMs))} max={Math.max(overview.p99Ms, 1)} />
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <SlowRoutesCard overview={overview} />
            <ErrorRoutesCard overview={overview} />
          </div>

          <DbQueriesCard overview={overview} />
          <WebVitalCard overview={overview} />
          <SuggestionsCard overview={overview} />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Route className="h-4 w-4" />
                All Routes
              </CardTitle>
              <CardDescription>Per-route breakdown of API performance</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Method</th>
                      <th className="pb-2 pr-4 font-medium">Route</th>
                      <th className="pb-2 pr-4 font-medium text-right">Count</th>
                      <th className="pb-2 pr-4 font-medium text-right">Avg</th>
                      <th className="pb-2 pr-4 font-medium text-right">p50</th>
                      <th className="pb-2 pr-4 font-medium text-right">p95</th>
                      <th className="pb-2 pr-4 font-medium text-right">p99</th>
                      <th className="pb-2 font-medium text-right">Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.buckets.map((bucket) => (
                      <tr key={`${bucket.method} ${bucket.route}`} className="border-b last:border-0">
                        <td className="py-2 pr-4">
                          <Badge variant="outline" className="font-mono text-xs">{bucket.method}</Badge>
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs max-w-[300px] truncate">{bucket.route}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{bucket.count}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatMs(Math.round(bucket.totalMs / bucket.count))}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatMs(bucket.p50Ms)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatMs(bucket.p95Ms)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatMs(bucket.p99Ms)}</td>
                        <td className="py-2 text-right font-mono">{formatMs(bucket.maxMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
