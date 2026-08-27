import type { Monitor } from '../types';
import { validateMonitorUrl } from './validation';
import { isInMaintenance } from './queries';
import { sendNotification } from './notifications';

export interface CheckResult {
	ok: boolean;
	status_code: number | null;
	response_time_ms: number;
	error: string | null;
}

interface ClaimedMonitor extends Monitor {
	check_claim_token: string;
}

const FAILURE_THRESHOLD = 2;
const CLAIM_SECONDS = 45;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 5;
const RETRY_COUNT = 2;

function publicError(error: unknown, timeoutMs: number): string {
	if (error instanceof DOMException && error.name === 'AbortError') return `Timeout after ${timeoutMs}ms`;
	return 'Connection failed';
}

export function getProbeRegions(checkRegions: string | null | undefined): string[] {
	if (!checkRegions) return [];
	const raw = String(checkRegions).trim();
	if (!raw) return [];
	if (raw.startsWith('[')) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
			}
		} catch {
			// fall through
		}
	}
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => {
			if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).trim();
			return s;
		})
		.filter(Boolean)
		.slice(0, 20);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function performCheck(monitor: Monitor, opts?: { probeRegion?: string }): Promise<CheckResult> {
	const initial = validateMonitorUrl(monitor.url);
	if (!initial.ok) return { ok: false, status_code: null, response_time_ms: 0, error: initial.error };
	if (monitor.method !== 'GET' && monitor.method !== 'HEAD') {
		return { ok: false, status_code: null, response_time_ms: 0, error: 'Unsupported request method' };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), monitor.timeout_ms);
	const started = Date.now();
	let current = initial.url;

	// Parse custom headers once
	const extraHeaders: Record<string, string> = {};
	if (monitor.custom_headers) {
		try {
			const parsed = JSON.parse(monitor.custom_headers);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
					if (typeof k === 'string' && typeof v === 'string') extraHeaders[k] = v;
				}
			}
		} catch {
			// ignore invalid JSON at check time (should have been validated on write)
		}
	}
	// Regional probe header
	const regions = getProbeRegions(monitor.check_regions);
	let probeRegion = opts?.probeRegion;
	if (!probeRegion && regions.length > 0) {
		probeRegion = regions[0];
	}
	if (probeRegion) {
		extraHeaders['X-Probe-Region'] = probeRegion;
	}

	const baseHeaders: Record<string, string> = { 'user-agent': 'UptimeCove/1.0 (+https://uptimecove.com)', ...extraHeaders };

	try {
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
			const response = await fetch(current, {
				method: monitor.method,
				redirect: 'manual',
				signal: controller.signal,
				headers: baseHeaders,
			});
			if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
				if (redirects === MAX_REDIRECTS) throw new Error('redirect-limit');
				const next = validateMonitorUrl(new URL(response.headers.get('location')!, current).toString());
				if (!next.ok) return { ok: false, status_code: response.status, response_time_ms: Date.now() - started, error: 'Unsafe redirect target' };
				current = next.url;
				continue;
			}
			// Status check
			let ok = response.status === monitor.expected_status;
			const errorParts: string[] = [];
			if (!ok) errorParts.push(`Expected ${monitor.expected_status}, got ${response.status}`);

			// Fetch body if needed for assertions (limit 512kb)
			let bodyText: string | null = null;
			const needsBody = (monitor.body_must_contain || monitor.body_must_not_contain) && monitor.method !== 'HEAD';
			if (needsBody) {
				try {
					// Clone or read body; respect 512kb limit
					const text = await response.text();
					bodyText = text.length > 512 * 1024 ? text.slice(0, 512 * 1024) : text;
				} catch {
					bodyText = '';
				}
				if (monitor.body_must_contain && bodyText !== null && !bodyText.includes(monitor.body_must_contain)) {
					ok = false;
					errorParts.push(`Body does not contain "${monitor.body_must_contain}"`);
				}
				if (monitor.body_must_not_contain && bodyText !== null && bodyText.includes(monitor.body_must_not_contain)) {
					ok = false;
					errorParts.push(`Body must not contain "${monitor.body_must_not_contain}"`);
				}
			}

			// Response time threshold check (use final time including body read if performed)
			const finalResponseTime = Date.now() - started;
			if (monitor.max_response_time_ms !== null && monitor.max_response_time_ms !== undefined) {
				const limit = Number(monitor.max_response_time_ms);
				if (finalResponseTime > limit) {
					ok = false;
					errorParts.push(`Response time ${finalResponseTime}ms exceeds limit of ${limit}ms`);
				}
			}

			// If max_response_time check added but we still report initial vs final, use final for response_time_ms
			return {
				ok,
				status_code: response.status,
				response_time_ms: finalResponseTime,
				error: errorParts.length ? errorParts.join('; ') : null,
			};
		}
		throw new Error('redirect-limit');
	} catch (error) {
		return { ok: false, status_code: null, response_time_ms: Date.now() - started, error: publicError(error, monitor.timeout_ms) };
	} finally {
		clearTimeout(timer);
	}
}

export async function performCheckWithRetry(monitor: Monitor, maxRetries = RETRY_COUNT): Promise<CheckResult> {
	const regions = getProbeRegions(monitor.check_regions);
	let last: CheckResult | null = null;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (attempt > 0) {
			const backoff = Math.min(5000, 300 * Math.pow(2, attempt - 1));
			// jitter: +/- 10%
			const jittered = backoff * (0.9 + Math.random() * 0.2);
			await sleep(jittered);
		}
		const region = regions.length > 0 ? regions[attempt % regions.length] : undefined;
		const result = await performCheck(monitor, region ? { probeRegion: region } : undefined);
		last = result;
		if (result.ok) return result;
		// Don't retry on validation errors (e.g., unsafe URL)
		if (result.error && (result.error.includes('Private') || result.error.includes('Unsupported') || result.error.includes('Unsafe redirect'))) {
			return result;
		}
		// otherwise retry on network/timeout or status mismatch
	}
	return last!;
}

async function claimMonitors(env: Env, nowSec: number, force: boolean): Promise<ClaimedMonitor[]> {
	const candidates = await env.DB.prepare(
		`SELECT * FROM monitors
		 WHERE enabled = 1
		   AND (? = 1 OR next_check_at <= ?)
		   AND (check_claimed_until IS NULL OR check_claimed_until < ?)
		 ORDER BY next_check_at ASC, id ASC LIMIT 50`
	).bind(force ? 1 : 0, nowSec, nowSec).all<Monitor>();

	const claimed: ClaimedMonitor[] = [];
	for (const monitor of candidates.results ?? []) {
		const token = crypto.randomUUID();
		const result = await env.DB.prepare(
			`UPDATE monitors SET check_claimed_until = ?, check_claim_token = ?
			 WHERE id = ? AND enabled = 1
			   AND (? = 1 OR next_check_at <= ?)
			   AND (check_claimed_until IS NULL OR check_claimed_until < ?)`
		).bind(nowSec + CLAIM_SECONDS, token, monitor.id, force ? 1 : 0, nowSec, nowSec).run();
		if ((result.meta.changes ?? 0) === 1) claimed.push({ ...monitor, check_claimed_until: nowSec + CLAIM_SECONDS, check_claim_token: token });
	}
	return claimed;
}

async function applyResult(
	env: Env,
	monitor: ClaimedMonitor,
	result: CheckResult,
	checkedAt: number,
	ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<boolean> {
	let failures = result.ok ? 0 : monitor.consecutive_failures + 1;
	let newStatus: Monitor['current_status'] = result.ok ? 'up' : failures >= FAILURE_THRESHOLD ? 'down' : monitor.current_status;
	const claimArgs = [monitor.id, monitor.check_claim_token];

	// Phase 1: skip alerting / incident creation if in maintenance, but still record checks
	let inMaintenance = false;
	try {
		inMaintenance = await isInMaintenance(env, monitor.id, checkedAt);
	} catch {
		inMaintenance = false;
	}
	if (inMaintenance && !result.ok) {
		// suppress incident and down transition during maintenance
		failures = 0;
		newStatus = monitor.current_status;
	}

	const statements = [
		env.DB.prepare(
			`INSERT INTO checks (monitor_id, ok, status_code, response_time_ms, error, checked_at)
			 SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS
			 (SELECT 1 FROM monitors WHERE id = ? AND check_claim_token = ?)`
		).bind(monitor.id, result.ok ? 1 : 0, result.status_code, result.response_time_ms, result.error, checkedAt, ...claimArgs),
	];

	const shouldOpen = !result.ok && failures >= FAILURE_THRESHOLD && monitor.current_status !== 'down' && !inMaintenance;
	const shouldRecover = result.ok && monitor.current_status === 'down';

	if (shouldOpen) {
		statements.push(env.DB.prepare(
			`INSERT OR IGNORE INTO incidents (monitor_id, cause, started_at)
			 SELECT ?, ?, ? WHERE EXISTS
			 (SELECT 1 FROM monitors WHERE id = ? AND check_claim_token = ?)`
		).bind(monitor.id, result.error ?? 'Check failed', checkedAt, ...claimArgs));
	}
	if (shouldRecover) {
		statements.push(env.DB.prepare(
			`UPDATE incidents SET resolved_at = ?
			 WHERE monitor_id = ? AND resolved_at IS NULL AND EXISTS
			 (SELECT 1 FROM monitors WHERE id = ? AND check_claim_token = ?)`
		).bind(checkedAt, monitor.id, ...claimArgs));
	}

	statements.push(env.DB.prepare(
		`UPDATE monitors SET current_status = ?, consecutive_failures = ?, last_checked_at = ?,
		 next_check_at = ?, check_claimed_until = NULL, check_claim_token = NULL
		 WHERE id = ? AND check_claim_token = ?`
	).bind(newStatus, failures, checkedAt, checkedAt + monitor.interval_seconds, ...claimArgs));

	const results = await env.DB.batch(statements);
	const ok = (results[results.length - 1].meta.changes ?? 0) === 1;

	// Phase 1: notifications — non-blocking via ctx.waitUntil if available, else await
	if (ok && (shouldOpen || shouldRecover)) {
		const event: 'open' | 'recovered' = shouldOpen ? 'open' : 'recovered';
		const notify = (async () => {
			try {
				const incident = shouldOpen
					? await env.DB.prepare(`SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1`).bind(monitor.id).first()
					: await env.DB.prepare(`SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 1`).bind(monitor.id).first();
				if (incident) {
					await sendNotification(env, monitor as Monitor, incident as unknown as import('../types').Incident, event);
				}
			} catch (e) {
				console.error('[monitor] notification dispatch failed', e);
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

	return ok;
}

async function releaseClaim(env: Env, monitor: ClaimedMonitor): Promise<void> {
	await env.DB.prepare(
		`UPDATE monitors SET check_claimed_until = NULL, check_claim_token = NULL
		 WHERE id = ? AND check_claim_token = ?`
	).bind(monitor.id, monitor.check_claim_token).run();
}

export async function runDueChecks(
	env: Env,
	now = Date.now(),
	force = false,
	ctx?: { waitUntil?: (p: Promise<unknown>) => void } | ((p: Promise<unknown>) => void),
): Promise<{ checked: number; failed: number }> {
	const nowSec = Math.floor(now / 1000);
	const claimed = await claimMonitors(env, nowSec, force);
	let checked = 0;
	let failed = 0;

	// normalize ctx: allow either object with waitUntil or direct function
	const waitUntilCtx = (() => {
		if (!ctx) return undefined;
		if (typeof ctx === 'function') return { waitUntil: ctx as (p: Promise<unknown>) => void };
		if (typeof (ctx as Record<string, unknown>).waitUntil === 'function') return ctx as { waitUntil: (p: Promise<unknown>) => void };
		return undefined;
	})();

	for (let offset = 0; offset < claimed.length; offset += CONCURRENCY) {
		await Promise.all(claimed.slice(offset, offset + CONCURRENCY).map(async (monitor) => {
			try {
				const result = await performCheckWithRetry(monitor, RETRY_COUNT);
				if (await applyResult(env, monitor, result, Math.floor(Date.now() / 1000), waitUntilCtx)) checked++;
			} catch (error) {
				failed++;
				console.error(`[uptimecove] monitor ${monitor.id} failed`, error);
				await releaseClaim(env, monitor);
			}
		}));
	}
	return { checked, failed };
}

export async function pruneOldChecks(env: Env, days = 90): Promise<number> {
	const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
	const result = await env.DB.prepare(`DELETE FROM checks WHERE checked_at < ?`).bind(cutoff).run();
	return result.meta.changes ?? 0;
}
