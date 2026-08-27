import type { Monitor, HeartbeatMonitor } from '../types';
import { isInMaintenance } from './queries';
import { sendNotification } from './notifications';

export interface HeartbeatCheckResult {
  heartbeatId: number;
  monitorId: number;
  ok: boolean;
  error: string | null;
  lastPingAt: number | null;
  graceSeconds: number;
  secondsSincePing: number | null;
}

export async function listHeartbeatMonitors(env: Env): Promise<Array<HeartbeatMonitor & { name: string; url: string; slug: string; current_status: string; enabled: number }>> {
  const res = await env.DB.prepare(
    `SELECT hm.*, m.name, m.url, m.slug, m.current_status, m.enabled
     FROM heartbeat_monitors hm
     JOIN monitors m ON m.id = hm.monitor_id
     ORDER BY hm.id DESC`
  ).all<HeartbeatMonitor & { name: string; url: string; slug: string; current_status: string; enabled: number }>();
  return (res.results ?? []) as Array<HeartbeatMonitor & { name: string; url: string; slug: string; current_status: string; enabled: number }>;
}

export async function getHeartbeatByMonitorId(env: Env, monitorId: number): Promise<HeartbeatMonitor | null> {
  const row = await env.DB.prepare(`SELECT * FROM heartbeat_monitors WHERE monitor_id = ?`).bind(monitorId).first<HeartbeatMonitor>();
  return row ?? null;
}

export async function createHeartbeatMonitor(env: Env, monitorId: number, graceSeconds = 300): Promise<{ ok: true; heartbeat: HeartbeatMonitor } | { ok: false; error: string }> {
  if (!Number.isInteger(monitorId)) return { ok: false, error: 'Invalid monitor id' };
  if (!Number.isInteger(graceSeconds) || graceSeconds < 60 || graceSeconds > 86400 * 7) return { ok: false, error: 'grace_seconds must be 60–604800' };
  const monitor = await env.DB.prepare(`SELECT id FROM monitors WHERE id = ?`).bind(monitorId).first();
  if (!monitor) return { ok: false, error: 'Monitor not found' };
  try {
    await env.DB.prepare(`INSERT INTO heartbeat_monitors (monitor_id, grace_seconds, last_ping_at) VALUES (?, ?, NULL)`).bind(monitorId, graceSeconds).run();
    const row = await getHeartbeatByMonitorId(env, monitorId);
    return { ok: true, heartbeat: row! };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('unique')) return { ok: false, error: 'Heartbeat already exists for this monitor' };
    return { ok: false, error: msg };
  }
}

export async function updateHeartbeatMonitor(env: Env, monitorId: number, graceSeconds: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(graceSeconds) || graceSeconds < 60 || graceSeconds > 86400 * 7) return { ok: false, error: 'grace_seconds must be 60–604800' };
  const res = await env.DB.prepare(`UPDATE heartbeat_monitors SET grace_seconds = ? WHERE monitor_id = ?`).bind(graceSeconds, monitorId).run();
  if ((res.meta.changes ?? 0) === 0) return { ok: false, error: 'Heartbeat not found' };
  return { ok: true };
}

export async function deleteHeartbeatMonitor(env: Env, monitorId: number): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM heartbeat_monitors WHERE monitor_id = ?`).bind(monitorId).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function recordPing(env: Env, heartbeatId: number, sourceIp: string | null, nowSec?: number): Promise<{ ok: true; pinged_at: number } | { ok: false; error: string }> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  // heartbeatId may be heartbeat table id or monitor id; try both
  let hb = await env.DB.prepare(`SELECT * FROM heartbeat_monitors WHERE id = ?`).bind(heartbeatId).first<HeartbeatMonitor>();
  if (!hb) {
    hb = await env.DB.prepare(`SELECT * FROM heartbeat_monitors WHERE monitor_id = ?`).bind(heartbeatId).first<HeartbeatMonitor>();
  }
  if (!hb) return { ok: false, error: 'Heartbeat not found' };

  await env.DB.batch([
    env.DB.prepare(`UPDATE heartbeat_monitors SET last_ping_at = ? WHERE id = ?`).bind(now, hb.id),
    env.DB.prepare(`INSERT INTO heartbeat_pings (heartbeat_id, pinged_at, source_ip) VALUES (?, ?, ?)`).bind(hb.id, now, sourceIp),
  ]);

  // Also update monitor status to up if it was down/paused
  await env.DB.prepare(`UPDATE monitors SET current_status = 'up', consecutive_failures = 0, last_checked_at = ? WHERE id = ? AND current_status != 'up'`).bind(now, hb.monitor_id).run().catch(() => {});

  // Resolve open incident if any
  await env.DB.prepare(`UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL`).bind(now, hb.monitor_id).run().catch(() => {});

  return { ok: true, pinged_at: now };
}

export async function checkHeartbeat(env: Env, heartbeat: HeartbeatMonitor, nowSec: number): Promise<HeartbeatCheckResult> {
  const grace = heartbeat.grace_seconds;
  const last = heartbeat.last_ping_at;
  const since = last === null ? null : nowSec - last;
  // If never pinged, consider failing after grace period since monitor creation or now
  let ok = true;
  let error: string | null = null;

  if (last === null) {
    // Fetch monitor created_at to decide
    const mon = await env.DB.prepare(`SELECT created_at FROM monitors WHERE id = ?`).bind(heartbeat.monitor_id).first<{ created_at: number }>();
    const created = mon?.created_at ?? nowSec;
    const elapsed = nowSec - created;
    if (elapsed > grace) {
      ok = false;
      error = `No ping received within ${grace}s (never pinged, created ${elapsed}s ago)`;
    }
  } else if (since !== null && since > grace) {
    ok = false;
    error = `Last ping ${since}s ago exceeds grace of ${grace}s`;
  }

  return { heartbeatId: heartbeat.id, monitorId: heartbeat.monitor_id, ok, error, lastPingAt: last, graceSeconds: grace, secondsSincePing: since };
}

export async function runHeartbeatChecks(
  env: Env,
  nowSec = Math.floor(Date.now() / 1000),
  ctx?: { waitUntil?: (p: Promise<unknown>) => void }
): Promise<{ checked: number; failed: number; results: HeartbeatCheckResult[] }> {
  const rows = await env.DB.prepare(
    `SELECT hm.*, m.current_status, m.consecutive_failures, m.name, m.url, m.slug
     FROM heartbeat_monitors hm
     JOIN monitors m ON m.id = hm.monitor_id
     WHERE m.enabled = 1`
  ).all<HeartbeatMonitor & { current_status: string; consecutive_failures: number; name: string; url: string; slug: string }>();

  const heartbeats = rows.results ?? [];
  let checked = 0;
  let failed = 0;
  const results: HeartbeatCheckResult[] = [];

  for (const hb of heartbeats) {
    const result = await checkHeartbeat(env, hb, nowSec);
    results.push(result);
    checked++;

    // Skip if in maintenance window (reuse queries helper)
    let inMaint = false;
    try {
      inMaint = await isInMaintenance(env, hb.monitor_id, nowSec);
    } catch {
      inMaint = false;
    }

    const shouldOpen = !result.ok && hb.current_status !== 'down' && !inMaint;
    const shouldRecover = result.ok && hb.current_status === 'down';

    // Determine incident handling
    if (!result.ok) failed++;

    // Write check row and update monitor status
    const monitorOk = result.ok ? 1 : 0;
    const batch: D1PreparedStatement[] = [];

    // Insert synthetic check record for heartbeat type
    batch.push(
      env.DB.prepare(
        `INSERT INTO checks (monitor_id, ok, status_code, response_time_ms, error, checked_at, region, monitor_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(hb.monitor_id, monitorOk, result.ok ? 200 : null, result.secondsSincePing !== null ? result.secondsSincePing * 1000 : 0, result.error, nowSec, 'heartbeat', 'heartbeat')
    );

    if (shouldOpen) {
      batch.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO incidents (monitor_id, cause, started_at) VALUES (?, ?, ?)`
        ).bind(hb.monitor_id, result.error ?? 'Heartbeat missed', nowSec)
      );
    }
    if (shouldRecover) {
      batch.push(
        env.DB.prepare(
          `UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL`
        ).bind(nowSec, hb.monitor_id)
      );
    }

    // Update monitor status
    const newStatus = !result.ok ? 'down' : result.ok && hb.current_status === 'down' ? 'up' : hb.current_status;
    const failures = !result.ok ? (hb.consecutive_failures ?? 0) + 1 : 0;
    batch.push(
      env.DB.prepare(
        `UPDATE monitors SET current_status = ?, consecutive_failures = ?, last_checked_at = ?, next_check_at = ? WHERE id = ?`
      ).bind(newStatus, failures, nowSec, nowSec + 60, hb.monitor_id)
    );

    try {
      await env.DB.batch(batch);
    } catch (e) {
      console.error('[heartbeat] batch failed', e);
    }

    if (shouldOpen || shouldRecover) {
      const event: 'open' | 'recovered' = shouldOpen ? 'open' : 'recovered';
      const notify = (async () => {
        try {
          const incident = shouldOpen
            ? await env.DB.prepare(`SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1`).bind(hb.monitor_id).first()
            : await env.DB.prepare(`SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 1`).bind(hb.monitor_id).first();
          if (incident) {
            const monitorRow = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`).bind(hb.monitor_id).first();
            if (monitorRow) await sendNotification(env, monitorRow as unknown as Monitor, incident as unknown as import('../types').Incident, event);
          }
        } catch (err) {
          console.error('[heartbeat] notification failed', err);
        }
      })();
      if (ctx?.waitUntil) {
        try {
          ctx.waitUntil(notify);
        } catch {
          await notify;
        }
      } else {
        await notify;
      }
    }
  }

  return { checked, failed, results };
}
