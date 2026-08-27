import type { Monitor } from '../types';
import type { CheckResult } from './monitor';

export interface DnsCheckResult extends CheckResult {
  records: string[];
  recordType: string;
}

/**
 * DNS check via Cloudflare DNS-over-HTTPS (https://cloudflare-dns.com/dns-query)
 * Compares resolved records against expected value if provided.
 */
export async function checkDns(monitor: Monitor): Promise<DnsCheckResult> {
  const started = Date.now();
  const timeoutMs = monitor.timeout_ms ?? 10000;

  // Determine hostname and expected values
  let hostname: string | null = null;
  const recordType = (monitor.dns_record_type ?? monitor.check_regions ?? 'A').toString().trim().toUpperCase() || 'A';
  // dns_record_type stored separately; fallback to parsing check_regions if it looks like a type
  const effectiveType = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].includes(recordType) ? recordType : 'A';
  const expectedRaw = monitor.dns_expected_value ?? null;

  try {
    const u = new URL(monitor.url);
    hostname = u.hostname;
  } catch {
    // url may be like dns://example.com or just hostname
    const raw = monitor.url.replace(/^dns:\/\//i, '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
    if (raw) hostname = raw;
  }

  // Override with explicit dns host if tcp_host is set? Or dns_expected_value may be hostname itself?
  if (!hostname && monitor.tcp_host) hostname = monitor.tcp_host;
  if (!hostname) {
    return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: 'Missing hostname for DNS check', records: [], recordType: effectiveType };
  }

  // Map record type to numeric DoH type
  const typeMap: Record<string, number> = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, NS: 2, SRV: 33, CAA: 257 };
  const qtype = typeMap[effectiveType] ?? 1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${qtype}`;
    const resp = await fetch(dohUrl, {
      headers: { accept: 'application/dns-json' },
      signal: controller.signal,
    });
    const responseTime = Date.now() - started;
    if (!resp.ok) {
      return { ok: false, status_code: resp.status, response_time_ms: responseTime, error: `DoH query failed ${resp.status}`, records: [], recordType: effectiveType };
    }
    const data = (await resp.json()) as {
      Answer?: Array<{ data: string; type: number }>;
      Status?: number;
    };
    if (data.Status !== 0) {
      return { ok: false, status_code: resp.status, response_time_ms: responseTime, error: `DNS status ${data.Status ?? 'unknown'}`, records: [], recordType: effectiveType };
    }
    const records: string[] = (data.Answer ?? []).map((a) => String(a.data).replace(/^"|"$/g, '').trim()).filter(Boolean);

    if (records.length === 0) {
      return { ok: false, status_code: resp.status, response_time_ms: responseTime, error: `No ${effectiveType} records found for ${hostname}`, records: [], recordType: effectiveType };
    }

    if (expectedRaw && expectedRaw.trim()) {
      const expected = expectedRaw.trim();
      const matched = records.some((r) => r === expected || r.includes(expected) || expected.includes(r));
      if (!matched) {
        return {
          ok: false,
          status_code: resp.status,
          response_time_ms: responseTime,
          error: `DNS mismatch: expected "${expected}" not in [${records.join(', ')}]`,
          records,
          recordType: effectiveType,
        };
      }
    }

    return { ok: true, status_code: resp.status, response_time_ms: responseTime, error: null, records, recordType: effectiveType };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : 'DNS query failed';
    return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: msg, records: [], recordType: effectiveType };
  } finally {
    clearTimeout(timer);
  }
}

export function isDnsMonitor(monitor: Monitor): boolean {
  if (monitor.monitor_type === 'dns') return true;
  try {
    const u = new URL(monitor.url);
    if (u.protocol === 'dns:') return true;
  } catch {}
  return false;
}
