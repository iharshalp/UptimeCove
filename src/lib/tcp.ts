import type { Monitor } from '../types';
import type { CheckResult } from './monitor';

/**
 * TCP check simulated via HTTP fetch.
 * Workers cannot open raw TCP sockets, so we treat tcp://host:port
 * and http(s) endpoints as TCP reachability probes:
 * any successful fetch (status < 500, or even any response) counts as TCP open.
 * For true tcp:// URLs we attempt fetch to http://host:port with HEAD.
 */
export async function checkTcp(monitor: Monitor): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = monitor.timeout_ms ?? 10000;

  let targetUrl: string | null = null;
  let host: string | null = monitor.tcp_host ?? null;
  let port: number | null = monitor.tcp_port ? Number(monitor.tcp_port) : null;

  try {
    const u = new URL(monitor.url);
    if (u.protocol === 'tcp:') {
      host = u.hostname;
      port = u.port ? Number(u.port) : port ?? 80;
      // Synthesize http URL for fetch probe
      const scheme = port === 443 ? 'https' : 'http';
      targetUrl = `${scheme}://${host}:${port}/`;
    } else if (u.protocol === 'http:' || u.protocol === 'https:') {
      targetUrl = u.toString();
      host = u.hostname;
      port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    }
  } catch {
    // fallback: raw host:port
    if (host && port) {
      const scheme = port === 443 ? 'https' : 'http';
      targetUrl = `${scheme}://${host}:${port}/`;
    }
  }

  if (!targetUrl) {
    if (host && port) {
      const scheme = port === 443 ? 'https' : 'http';
      targetUrl = `${scheme}://${host}:${port}/`;
    } else {
      return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: 'Invalid TCP target' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // For TCP we use HEAD to minimize body, but fallback to GET if HEAD blocked
    let resp = await fetch(targetUrl, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    // If HEAD returns 405, retry with GET
    if (resp.status === 405) {
      resp = await fetch(targetUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
    }
    const elapsed = Date.now() - started;
    // Any response (including 4xx) means TCP reachable; only network errors are failures
    // Consider 2xx/3xx as ok, 4xx as ok for TCP purposes? We'll consider ok if status < 500
    const ok = resp.status < 500;
    return {
      ok,
      status_code: resp.status,
      response_time_ms: elapsed,
      error: ok ? null : `TCP probe returned ${resp.status}`,
    };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : 'TCP connection failed';
    return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function isTcpMonitor(monitor: Monitor): boolean {
  if (monitor.monitor_type === 'tcp') return true;
  try {
    const u = new URL(monitor.url);
    if (u.protocol === 'tcp:') return true;
  } catch {}
  return false;
}
