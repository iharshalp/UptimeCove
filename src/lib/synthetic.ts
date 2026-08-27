import type { Monitor } from '../types';
import type { CheckResult } from './monitor';

export interface SyntheticStep {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  expected_status?: number;
  must_contain?: string | null;
  must_not_contain?: string | null;
  timeout_ms?: number;
}

export interface SyntheticCheckResult extends CheckResult {
  steps_total: number;
  steps_passed: number;
  step_errors: string[];
}

/**
 * Multi-step synthetic / browser check.
 * Steps are stored as JSON in monitors.steps or monitors.check_regions (fallback).
 * Each step is executed sequentially via fetch, carrying forward cookies if needed.
 * Minimal browser simulation: sequential fetches, checks status/body assertions.
 */
export async function runSyntheticCheck(monitor: Monitor): Promise<SyntheticCheckResult> {
  const started = Date.now();
  const timeoutMs = monitor.timeout_ms ?? 10000;

  let steps: SyntheticStep[] = [];
  const raw = monitor.steps ?? monitor.check_regions ?? null;

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        steps = parsed as SyntheticStep[];
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).steps)) {
        steps = (parsed as Record<string, SyntheticStep[]>).steps;
      } else if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).url) {
        steps = [parsed as SyntheticStep];
      }
    } catch {
      // fallback: treat check_regions as comma-separated URLs
      if (typeof raw === 'string' && raw.includes('http')) {
        const urls = raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
        steps = urls.map((u) => ({ url: u }));
      }
    }
  }

  // If no steps parsed but monitor.url is valid, treat as single-step synthetic
  if (steps.length === 0) {
    steps = [{ url: monitor.url }];
  }

  const stepErrors: string[] = [];
  let stepsPassed = 0;
  let lastStatus: number | null = null;
  const cookieJar: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepUrl = step.url ?? monitor.url;
    const method = (step.method ?? 'GET').toUpperCase();
    const expectedStatus = step.expected_status ?? monitor.expected_status ?? 200;
    const mustContain = step.must_contain ?? monitor.body_must_contain ?? null;
    const mustNotContain = step.must_not_contain ?? monitor.body_must_not_contain ?? null;
    const stepTimeout = step.timeout_ms ?? timeoutMs;

    // Validate method
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      stepErrors.push(`Step ${i + 1}: unsupported method ${method}`);
      break;
    }

    // Validate URL
    let urlObj: URL;
    try {
      urlObj = new URL(stepUrl);
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') throw new Error('invalid protocol');
    } catch {
      stepErrors.push(`Step ${i + 1}: invalid URL ${stepUrl}`);
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), stepTimeout);
    const stepStart = Date.now();

    try {
      const headers: Record<string, string> = {
        'user-agent': 'UptimeCove-Synthetic/1.0',
        ...(step.headers ?? {}),
      };
      if (cookieJar.length) headers['cookie'] = cookieJar.join('; ');

      // Parse custom_headers from monitor if present
      if (monitor.custom_headers) {
        try {
          const extra = JSON.parse(monitor.custom_headers);
          if (extra && typeof extra === 'object') Object.assign(headers, extra);
        } catch {}
      }

      const fetchInit: RequestInit = {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      };
      if (step.body && method !== 'GET' && method !== 'HEAD') {
        (fetchInit as Record<string, unknown>).body = step.body;
      }

      const resp = await fetch(urlObj.toString(), fetchInit);
      lastStatus = resp.status;

      // Capture cookies
      const setCookie = resp.headers.get('set-cookie');
      if (setCookie) cookieJar.push(setCookie.split(';')[0]);

      if (resp.status !== expectedStatus) {
        stepErrors.push(`Step ${i + 1}: expected ${expectedStatus}, got ${resp.status} at ${stepUrl}`);
        break;
      }

      if ((mustContain || mustNotContain) && method !== 'HEAD') {
        let bodyText = '';
        try {
          bodyText = await resp.text();
          if (bodyText.length > 512 * 1024) bodyText = bodyText.slice(0, 512 * 1024);
        } catch {
          bodyText = '';
        }
        if (mustContain && !bodyText.includes(mustContain)) {
          stepErrors.push(`Step ${i + 1}: body does not contain "${mustContain}"`);
          break;
        }
        if (mustNotContain && bodyText.includes(mustNotContain)) {
          stepErrors.push(`Step ${i + 1}: body must not contain "${mustNotContain}"`);
          break;
        }
      }

      stepsPassed++;

      // Respect max_response_time_ms per monitor if set (applied to total synthetic time)
      if (monitor.max_response_time_ms !== null && monitor.max_response_time_ms !== undefined) {
        const totalElapsed = Date.now() - started;
        if (totalElapsed > monitor.max_response_time_ms) {
          stepErrors.push(`Synthetic exceeded max_response_time_ms ${monitor.max_response_time_ms}ms after step ${i + 1}`);
          break;
        }
      }

      // Small delay between steps to simulate browser pacing (avoid hammering)
      if (i < steps.length - 1) await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'AbortError' ? `Timeout after ${stepTimeout}ms` : 'Connection failed';
      stepErrors.push(`Step ${i + 1}: ${msg} at ${stepUrl}`);
      break;
    } finally {
      clearTimeout(timer);
      // If step took too long overall, we already accounted
      void stepStart;
    }
  }

  const totalTime = Date.now() - started;
  const ok = stepErrors.length === 0 && stepsPassed === steps.length;

  return {
    ok,
    status_code: lastStatus,
    response_time_ms: totalTime,
    error: ok ? null : stepErrors.join('; '),
    steps_total: steps.length,
    steps_passed: stepsPassed,
    step_errors: stepErrors,
  };
}

export function isSyntheticMonitor(monitor: Monitor): boolean {
  if (monitor.monitor_type === 'synthetic' || monitor.monitor_type === 'browser' || monitor.monitor_type === 'multi_step') return true;
  if (monitor.steps && monitor.steps.trim().startsWith('[')) return true;
  // Heuristic: check_regions containing JSON array of steps
  if (monitor.check_regions) {
    const s = monitor.check_regions.trim();
    if (s.startsWith('[') && s.includes('"url"')) return true;
  }
  return false;
}

export function parseSyntheticSteps(monitor: Monitor): SyntheticStep[] | null {
  const raw = monitor.steps ?? monitor.check_regions ?? null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SyntheticStep[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).steps)) return (parsed as Record<string, SyntheticStep[]>).steps;
  } catch {
    return null;
  }
  return null;
}
