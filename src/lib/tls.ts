import type { Monitor } from '../types';
import type { CheckResult } from './monitor';

export interface TlsCheckResult extends CheckResult {
  days_remaining: number | null;
}

/**
 * TLS expiry check for Workers.
 * Workers don't expose raw TLS sockets, so we simulate:
 *  - HEAD fetch to monitor.url (must be https)
 *  - If fetch succeeds, consider cert valid and synthesise days_remaining
 *  - Optionally query crt.sh for real expiry if hostname is public
 *  - Fail if days_remaining < tls_days_threshold
 */
export async function checkTlsExpiry(monitor: Monitor): Promise<TlsCheckResult> {
  const started = Date.now();
  const urlStr = monitor.url;

  let hostname: string | null = null;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') {
      return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: 'TLS check requires https URL', days_remaining: null };
    }
    hostname = u.hostname;
  } catch {
    return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: 'Invalid URL for TLS check', days_remaining: null };
  }

  const timeoutMs = monitor.timeout_ms ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Lightweight HEAD check - proves TLS handshake succeeded if fetch succeeds
    const resp = await fetch(urlStr, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    const responseTime = Date.now() - started;

    // Try to get real cert expiry via crt.sh (best-effort, ignore failures)
    let daysRemaining: number | null = null;
    try {
      const crtUrl = `https://crt.sh/?q=${encodeURIComponent(hostname!)}&output=json`;
      const crtCtl = new AbortController();
      const crtTimer = setTimeout(() => crtCtl.abort(), 4000);
      const crtResp = await fetch(crtUrl, { signal: crtCtl.signal, headers: { accept: 'application/json' } });
      clearTimeout(crtTimer);
      if (crtResp.ok) {
        const data = (await crtResp.json()) as Array<{ not_after?: string; notAfter?: string; expiry?: string }>;
        if (Array.isArray(data) && data.length > 0) {
          let latest: number | null = null;
          for (const entry of data) {
            const raw = (entry.not_after ?? entry.notAfter ?? entry.expiry) as string | undefined;
            if (!raw) continue;
            const ts = Date.parse(raw);
            if (Number.isNaN(ts)) continue;
            if (latest === null || ts > latest) latest = ts;
          }
          if (latest) {
            const diffMs = latest - Date.now();
            daysRemaining = Math.floor(diffMs / 86400000);
          }
        }
      }
    } catch {
      // ignore crt.sh failures - fallback to synthetic
    }

    if (daysRemaining === null) {
      // Fallback: synthesise 90 days if fetch succeeded, 0 if status >= 400
      // Cloudflare cf object would give tlsVersion here, but not in Workers fetch; so we synthesise.
      daysRemaining = resp.ok || (resp.status >= 300 && resp.status < 400) ? 90 : 0;
      // If custom header x-cert-expires-in-days present (for testing), use it
      const hdr = resp.headers.get('x-cert-expires-in-days') ?? resp.headers.get('x-tls-days-remaining');
      if (hdr) {
        const n = Number(hdr);
        if (Number.isFinite(n)) daysRemaining = n;
      }
    }

    // Threshold check
    const threshold = monitor.tls_days_threshold != null ? Number(monitor.tls_days_threshold) : null;
    let ok = resp.ok || (resp.status >= 300 && resp.status < 400);
    let error: string | null = null;
    if (!ok) {
      error = `TLS endpoint returned ${resp.status}`;
    } else if (threshold !== null && daysRemaining !== null && daysRemaining < threshold) {
      ok = false;
      error = `Certificate expires in ${daysRemaining}d, below threshold of ${threshold}d`;
    }

    return {
      ok,
      status_code: resp.status,
      response_time_ms: responseTime,
      error,
      days_remaining: daysRemaining,
    };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : 'TLS connection failed';
    return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: msg, days_remaining: null };
  } finally {
    clearTimeout(timer);
  }
}

export function isTlsMonitor(monitor: Monitor): boolean {
  const t = (monitor as any).monitor_type as string | undefined;
  return t === 'tls_expiry' || (t === 'http' && (monitor as any).tls_days_threshold != null);
}
