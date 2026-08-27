import type { Monitor } from '../types';

export async function checkTlsExpiry(monitor: Monitor): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = new URL(monitor.url);
    if (url.protocol !== 'https:') return { ok: true };
    // Workers don't expose TLS cert directly; use fetch and check cf.tls if available via request.cf
    // Fallback: attempt fetch and consider ok if fetch succeeds; for threshold, we simulate
    const threshold = (monitor as any).tls_expiry_threshold_days ?? (monitor as any).tls_days_threshold ?? 14;
    // Try to fetch with HEAD and check for expiry header if present (not standard)
    // For demo, we consider TLS valid if host is reachable
    const res = await fetch(monitor.url, { method: 'HEAD', redirect: 'manual' });
    if (!res.ok && res.status >= 400) return { ok: false, error: `TLS check: HTTP ${res.status}` };
    // In real deployment, integrate with Cloudflare API or external checker
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'TLS check failed' };
  }
}

export async function checkDns(monitor: Monitor): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = new URL(monitor.url);
    const hostname = url.hostname;
    const expected = monitor.dns_expected_value?.trim();
    if (!expected) return { ok: true };
    // Use Cloudflare DNS over HTTPS
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' },
    });
    const data: any = await res.json().catch(() => ({}));
    const answers: string[] = (data.Answer ?? []).map((a: any) => String(a.data));
    if (answers.length === 0) return { ok: false, error: 'No DNS answer' };
    if (!answers.includes(expected) && !answers.some(a => a.includes(expected))) {
      return { ok: false, error: `DNS mismatch: got ${answers.join(',')} expected ${expected}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'DNS check failed' };
  }
}

export async function checkTcp(monitor: Monitor): Promise<{ ok: boolean; error?: string }> {
  try {
    const port = monitor.tcp_port ?? (new URL(monitor.url).port ? Number(new URL(monitor.url).port) : 443);
    const url = new URL(monitor.url);
    // Workers cannot do raw TCP, so we simulate via fetch to same host:port with HEAD
    const testUrl = `${url.protocol}//${url.hostname}:${port}/`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), monitor.timeout_ms ?? 5000);
    try {
      const res = await fetch(testUrl, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
      if (res.status >= 200 && res.status < 600) return { ok: true };
      return { ok: false, error: `TCP port ${port} check failed: ${res.status}` };
    } finally { clearTimeout(t); }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'TCP check failed' };
  }
}

export async function checkSynthetic(monitor: Monitor): Promise<{ ok: boolean; error?: string }> {
  const raw = (monitor as any).synthetic_steps ?? (monitor as any).steps;
  if (!raw) return { ok: true };
  try {
    const steps: Array<{ url: string; must_contain?: string }> = JSON.parse(String(raw));
    if (!Array.isArray(steps) || steps.length === 0) return { ok: true };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const res = await fetch(step.url, { headers: { 'user-agent': 'UptimeCove-Synthetic/1.0' } });
      const body = await res.text().catch(() => '');
      if (step.must_contain && !body.includes(step.must_contain)) {
        return { ok: false, error: `Step ${i+1} failed: body does not contain "${step.must_contain}"` };
      }
      if (!res.ok) return { ok: false, error: `Step ${i+1} HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Synthetic check failed' };
  }
}

export async function checkHeartbeat(env: Env, monitor: Monitor): Promise<{ ok: boolean; error?: string }> {
  const hb: any = await env.DB.prepare(`SELECT grace_seconds, last_ping_at FROM heartbeat_monitors WHERE monitor_id = ?`).bind(monitor.id).first();
  if (!hb) return { ok: true };
  const now = Math.floor(Date.now()/1000);
  const last = hb.last_ping_at ?? 0;
  if (last === 0) return { ok: false, error: 'No heartbeat received yet' };
  if (now - last > (hb.grace_seconds ?? 300)) return { ok: false, error: `Heartbeat overdue by ${now - last - (hb.grace_seconds ?? 300)}s` };
  return { ok: true };
}
