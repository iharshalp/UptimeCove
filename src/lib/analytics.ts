/**
 * Regional analytics: aggregate per-region latency and uptime.
 * Works with checks.region column added in 0004_phase3.
 * Falls back gracefully if region column is null (treat as "auto").
 */

export interface RegionalStats {
  region: string;
  count: number;
  ok: number;
  uptime_pct: number | null;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

export interface GlobalAnalytics {
  totalChecks: number;
  uptimePct: number | null;
  avgMs: number | null;
  regions: RegionalStats[];
  latency: { p50: number | null; p95: number | null; p99: number | null };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function getRegionalAnalytics(
  env: Env,
  monitorId?: number | null,
  days = 7
): Promise<GlobalAnalytics> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const monitorFilter = monitorId ? 'AND monitor_id = ?' : '';
  const params: unknown[] = monitorId ? [since, monitorId] : [since];

  // Global stats
  const globalRow = await env.DB.prepare(
    `SELECT COUNT(*) as total, SUM(ok) as ok_count, AVG(response_time_ms) as avg_ms FROM checks WHERE checked_at >= ? ${monitorFilter}`
  )
    .bind(...params)
    .first<{ total: number; ok_count: number | null; avg_ms: number | null }>();

  const totalChecks = globalRow?.total ?? 0;
  const uptimePct = totalChecks > 0 && globalRow?.ok_count != null ? (Number(globalRow.ok_count) / totalChecks) * 100 : null;
  const avgMs = globalRow?.avg_ms != null ? Math.round(Number(globalRow.avg_ms)) : null;

  // Per-region aggregation via SQL
  const perRegion = await env.DB.prepare(
    `SELECT COALESCE(region, 'auto') as region,
            COUNT(*) as total,
            SUM(ok) as ok_count,
            AVG(response_time_ms) as avg_ms
     FROM checks
     WHERE checked_at >= ? ${monitorFilter}
     GROUP BY COALESCE(region, 'auto')
     ORDER BY total DESC`
  )
    .bind(...params)
    .all<{ region: string; total: number; ok_count: number | null; avg_ms: number | null }>();

  // Fetch detailed latencies per region for percentiles (JS computed)
  const regions: RegionalStats[] = [];
  for (const row of perRegion.results ?? []) {
    const region = row.region ?? 'auto';
    const cnt = Number(row.total);
    const okCount = Number(row.ok_count ?? 0);
    const regionUptime = cnt > 0 ? (okCount / cnt) * 100 : null;
    const regionAvg = row.avg_ms != null ? Math.round(Number(row.avg_ms)) : null;

    // Fetch sorted response times for percentile calc (limit to 5000 latest to avoid huge scan)
    const latRes = await env.DB.prepare(
      `SELECT response_time_ms FROM checks
       WHERE checked_at >= ? ${monitorFilter} AND COALESCE(region, 'auto') = ? AND response_time_ms IS NOT NULL
       ORDER BY response_time_ms ASC LIMIT 5000`
    )
      .bind(...(monitorId ? [since, monitorId, region] : [since, region]))
      .all<{ response_time_ms: number }>();

    const vals = (latRes.results ?? []).map((r) => r.response_time_ms).sort((a, b) => a - b);
    const p50 = percentile(vals, 50);
    const p95 = percentile(vals, 95);
    const p99 = percentile(vals, 99);

    regions.push({
      region,
      count: cnt,
      ok: okCount,
      uptime_pct: regionUptime,
      avg_ms: regionAvg,
      p50_ms: p50,
      p95_ms: p95,
      p99_ms: p99,
    });
  }

  // Global latency percentiles
  const globalLat = await env.DB.prepare(
    `SELECT response_time_ms FROM checks WHERE checked_at >= ? ${monitorFilter} AND response_time_ms IS NOT NULL ORDER BY response_time_ms ASC LIMIT 5000`
  )
    .bind(...params)
    .all<{ response_time_ms: number }>();
  const globalVals = (globalLat.results ?? []).map((r) => r.response_time_ms).sort((a, b) => a - b);

  return {
    totalChecks,
    uptimePct,
    avgMs,
    regions,
    latency: {
      p50: percentile(globalVals, 50),
      p95: percentile(globalVals, 95),
      p99: percentile(globalVals, 99),
    },
  };
}

export async function getMonitorRegionalBreakdown(
  env: Env,
  monitorId: number,
  days = 30
): Promise<RegionalStats[]> {
  const { regions } = await getRegionalAnalytics(env, monitorId, days);
  return regions;
}

export async function getGlobalRegionalSummary(env: Env, days = 7): Promise<GlobalAnalytics> {
  return getRegionalAnalytics(env, null, days);
}
