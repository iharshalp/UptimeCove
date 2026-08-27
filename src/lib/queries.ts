import type { Monitor, Check, Incident, IncidentUpdate, MaintenanceWindow } from '../types';
import { parseInteger, validateBodySnippet, validateCustomHeaders, validateMaxResponseTime, validateMonitorUrl } from './validation';
import { getProbeRegions as _getProbeRegions } from './subscribers';
import { logAudit } from './auth';

export { getProbeRegions } from './subscribers';
export { createSubscriber, verifySubscriber, listSubscribers, deleteSubscriber, generateRssFeed, generateBadgeSvg, computePageUptime, isValidEmail } from './subscribers';

export interface DailyUptime {
	day: string;
	total: number;
	ok: number;
	avg_ms: number | null;
}

export async function listMonitors(env: Env): Promise<Monitor[]> {
	const res = await env.DB.prepare(`SELECT * FROM monitors ORDER BY created_at DESC`).all<Monitor>();
	return res.results ?? [];
}

export async function getPageMonitors(env: Env, pageId = 1): Promise<Monitor[]> {
	const linked = await env.DB.prepare(
		`SELECT m.* FROM status_page_monitors spm
		 JOIN monitors m ON m.id = spm.monitor_id AND m.enabled = 1
		 WHERE spm.page_id = ? ORDER BY spm.sort_order`
	).bind(pageId).all<Monitor>();
	const results = linked.results ?? [];
	if (results.length > 0) return results;
	if (pageId === 1) return listMonitors(env);
	return [];
}

export async function getStatusPage(env: Env, slug: string) {
	return env.DB.prepare(`SELECT * FROM status_pages WHERE slug = ?`).bind(slug).first();
}

export async function getDailyUptime(env: Env, monitorId: number, days = 90): Promise<DailyUptime[]> {
	const since = Math.floor(Date.now() / 1000) - days * 86400;
	const res = await env.DB.prepare(
		`SELECT date(checked_at, 'unixepoch') AS day,
				COUNT(*) AS total,
				SUM(ok) AS ok,
				CAST(AVG(response_time_ms) AS INTEGER) AS avg_ms
		 FROM checks
		 WHERE monitor_id = ? AND checked_at >= ?
		 GROUP BY day ORDER BY day ASC`
	).bind(monitorId, since).all<DailyUptime>();
	return res.results ?? [];
}

export async function getMonitorUptime(env: Env, monitorId: number, days = 30): Promise<number | null> {
	const since = Math.floor(Date.now() / 1000) - days * 86400;
	const row = await env.DB.prepare(
		`SELECT CAST(100.0 * SUM(ok) / COUNT(*) AS REAL) AS pct FROM checks WHERE monitor_id = ? AND checked_at >= ?`
	).bind(monitorId, since).first<{ pct: number | null }>();
	if (!row || row.pct === null) return null;
	return row.pct;
}

export async function getMonitorLatencyPercentiles(env: Env, monitorId: number, days = 7): Promise<{ p50: number | null; p95: number | null; p99: number | null }> {
	const since = Math.floor(Date.now() / 1000) - days * 86400;
	// Fetch sorted response times and compute percentiles in JS (D1 doesn't have percentile functions)
	const res = await env.DB.prepare(
		`SELECT response_time_ms FROM checks WHERE monitor_id = ? AND checked_at >= ? AND response_time_ms IS NOT NULL ORDER BY response_time_ms ASC`
	).bind(monitorId, since).all<{ response_time_ms: number }>();
	const vals = (res.results ?? []).map((r) => r.response_time_ms).sort((a, b) => a - b);
	if (vals.length === 0) return { p50: null, p95: null, p99: null };
	const pick = (p: number) => vals[Math.min(vals.length - 1, Math.floor((p / 100) * vals.length))];
	return { p50: pick(50), p95: pick(95), p99: pick(99) };
}

export async function getIncidents(env: Env, monitorId: number, limit = 10): Promise<Incident[]> {
	const res = await env.DB.prepare(
		`SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?`
	).bind(monitorId, limit).all<Incident>();
	return res.results ?? [];
}

export async function getRecentChecks(env: Env, monitorId: number, limit = 25): Promise<Check[]> {
	const res = await env.DB.prepare(
		`SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?`
	).bind(monitorId, limit).all<Check>();
	return res.results ?? [];
}

function randomSuffix(len = 6): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(len)), (value) => (value % 36).toString(36)).join('');
}

export interface MonitorInput {
	name: string;
	url: string;
	method?: string;
	expected_status?: number;
	interval_seconds?: number;
	timeout_ms?: number;
	body_must_contain?: string | null;
	body_must_not_contain?: string | null;
	max_response_time_ms?: number | string | null;
	custom_headers?: string | null;
	check_regions?: string | null;
}

export async function getMonitorById(env: Env, id: number): Promise<Monitor | null> {
	const row = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`).bind(id).first<Monitor>();
	return row ?? null;
}

export async function createMonitor(env: Env, input: MonitorInput): Promise<{ ok: true; monitor: Monitor } | { ok: false; error: string }> {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid monitor data' };
	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
	const target = validateMonitorUrl(input.url);
	if (!target.ok) return target;
	if (!name) return { ok: false, error: 'Name is required' };

	const method = (input.method ?? 'GET').toUpperCase();
	if (!['GET', 'HEAD'].includes(method)) return { ok: false, error: 'Only GET and HEAD monitors are supported' };

	const expected_status = parseInteger(input.expected_status, 200, 100, 599);
	const interval_seconds = parseInteger(input.interval_seconds, 60, 60, 86400);
	const timeout_ms = parseInteger(input.timeout_ms, 10000, 1000, 30000);
	if (expected_status === null || interval_seconds === null || timeout_ms === null) {
		return { ok: false, error: 'Status, interval, and timeout must be valid whole numbers' };
	}

	const bodyMustContain = validateBodySnippet(input.body_must_contain, 'body_must_contain');
	if (!bodyMustContain.ok) return { ok: false, error: bodyMustContain.error };
	const bodyMustNotContain = validateBodySnippet(input.body_must_not_contain, 'body_must_not_contain');
	if (!bodyMustNotContain.ok) return { ok: false, error: bodyMustNotContain.error };
	const maxResp = validateMaxResponseTime(input.max_response_time_ms);
	if (!maxResp.ok) return { ok: false, error: maxResp.error };
	const headersCheck = validateCustomHeaders(input.custom_headers);
	if (!headersCheck.ok) return { ok: false, error: headersCheck.error };
	const checkRegions = typeof input.check_regions === 'string' ? input.check_regions.trim().slice(0, 500) || null : (input.check_regions ?? null);

	const now = Math.floor(Date.now() / 1000);

	const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'monitor';
	const slug = `${baseSlug}-${randomSuffix()}`;

	const insert = await env.DB.prepare(
		`INSERT INTO monitors (slug, name, url, method, expected_status, interval_seconds, timeout_ms, body_must_contain, body_must_not_contain, max_response_time_ms, custom_headers, check_regions, created_at, next_check_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
	).bind(slug, name, target.url.toString(), method, expected_status, interval_seconds, timeout_ms, bodyMustContain.value, bodyMustNotContain.value, maxResp.value, headersCheck.value, checkRegions, now).run();

	const row = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`).bind(insert.meta.last_row_id).first<Monitor>();
	try { await logAudit(env, { actor: 'admin', action: 'monitor.create', target_type: 'monitor', target_id: String(row!.id), metadata: JSON.stringify({ name, url: target.url.toString() }) }); } catch {}
	return { ok: true, monitor: row! };
}

export async function updateMonitor(env: Env, id: number, input: MonitorInput): Promise<{ ok: true; monitor: Monitor } | { ok: false; error: string }> {
	if (!Number.isInteger(id)) return { ok: false, error: 'Invalid monitor id' };
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid monitor data' };
	const existing = await getMonitorById(env, id);
	if (!existing) return { ok: false, error: 'Monitor not found' };

	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : existing.name;
	if (!name) return { ok: false, error: 'Name is required' };

	let urlValue = existing.url;
	if (input.url !== undefined) {
		const target = validateMonitorUrl(input.url);
		if (!target.ok) return { ok: false, error: target.error };
		urlValue = target.url.toString();
	}

	const methodRaw = input.method !== undefined ? String(input.method).toUpperCase() : existing.method;
	if (!['GET', 'HEAD'].includes(methodRaw)) return { ok: false, error: 'Only GET and HEAD monitors are supported' };

	const expected_status = parseInteger(input.expected_status, existing.expected_status, 100, 599);
	const interval_seconds = parseInteger(input.interval_seconds, existing.interval_seconds, 60, 86400);
	const timeout_ms = parseInteger(input.timeout_ms, existing.timeout_ms, 1000, 30000);
	if (expected_status === null || interval_seconds === null || timeout_ms === null) {
		return { ok: false, error: 'Status, interval, and timeout must be valid whole numbers' };
	}

	const bodyMustContainInput = Object.prototype.hasOwnProperty.call(input, 'body_must_contain') ? input.body_must_contain : existing.body_must_contain;
	const bodyMustNotContainInput = Object.prototype.hasOwnProperty.call(input, 'body_must_not_contain') ? input.body_must_not_contain : existing.body_must_not_contain;
	const maxRespInput = Object.prototype.hasOwnProperty.call(input, 'max_response_time_ms') ? input.max_response_time_ms : existing.max_response_time_ms;
	const customHeadersInput = Object.prototype.hasOwnProperty.call(input, 'custom_headers') ? input.custom_headers : existing.custom_headers;
	const checkRegionsInput = Object.prototype.hasOwnProperty.call(input, 'check_regions') ? input.check_regions : existing.check_regions;

	const bodyMustContain = validateBodySnippet(bodyMustContainInput, 'body_must_contain');
	if (!bodyMustContain.ok) return { ok: false, error: bodyMustContain.error };
	const bodyMustNotContain = validateBodySnippet(bodyMustNotContainInput, 'body_must_not_contain');
	if (!bodyMustNotContain.ok) return { ok: false, error: bodyMustNotContain.error };
	const maxResp = validateMaxResponseTime(maxRespInput);
	if (!maxResp.ok) return { ok: false, error: maxResp.error };
	const headersCheck = validateCustomHeaders(customHeadersInput);
	if (!headersCheck.ok) return { ok: false, error: headersCheck.error };
	const checkRegions = typeof checkRegionsInput === 'string' ? checkRegionsInput.trim().slice(0, 500) || null : (checkRegionsInput ?? null);

	await env.DB.prepare(
		`UPDATE monitors SET name = ?, url = ?, method = ?, expected_status = ?, interval_seconds = ?, timeout_ms = ?, body_must_contain = ?, body_must_not_contain = ?, max_response_time_ms = ?, custom_headers = ?, check_regions = ? WHERE id = ?`
	).bind(name, urlValue, methodRaw, expected_status, interval_seconds, timeout_ms, bodyMustContain.value, bodyMustNotContain.value, maxResp.value, headersCheck.value, checkRegions, id).run();

	const row = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`).bind(id).first<Monitor>();
	try { await logAudit(env, { actor: 'admin', action: 'monitor.update', target_type: 'monitor', target_id: String(id), metadata: JSON.stringify({ name }) }); } catch {}
	return { ok: true, monitor: row! };
}

export async function deleteMonitor(env: Env, id: number): Promise<boolean> {
	const result = await env.DB.prepare(`DELETE FROM monitors WHERE id = ?`).bind(id).run();
	const ok = (result.meta.changes ?? 0) === 1;
	if (ok) { try { await logAudit(env, { actor: 'admin', action: 'monitor.delete', target_type: 'monitor', target_id: String(id) }); } catch {} }
	return ok;
}

export async function toggleMonitor(env: Env, id: number): Promise<boolean> {
	const result = await env.DB.prepare(
		`UPDATE monitors SET
		   enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END,
		   current_status = CASE WHEN enabled = 1 THEN 'paused' ELSE 'pending' END,
		   consecutive_failures = 0
		 WHERE id = ?`
	).bind(id).run();
	const ok = (result.meta.changes ?? 0) === 1;
	if (ok) { try { await logAudit(env, { actor: 'admin', action: 'monitor.toggle', target_type: 'monitor', target_id: String(id) }); } catch {} }
	return ok;
}

export interface IncidentWithMonitor extends Incident {
	name: string;
	url: string;
}

export async function getRecentIncidents(env: Env, limit = 8): Promise<IncidentWithMonitor[]> {
	const res = await env.DB.prepare(
		`SELECT i.*, m.name, m.url FROM incidents i
		 JOIN monitors m ON m.id = i.monitor_id
		 ORDER BY i.started_at DESC LIMIT ?`
	).bind(limit).all<IncidentWithMonitor>();
	return res.results ?? [];
}

export interface DashboardStats {
	activeMonitors: number;
	totalMonitors: number;
	checks24h: number;
	incidents: number;
	ongoingIncidents: number;
	statusPages: number;
	globalUptimePct: number | null;
}

export async function getDashboardStats(env: Env): Promise<DashboardStats> {
	const since24h = Math.floor(Date.now() / 1000) - 86400;
	const since30d = Math.floor(Date.now() / 1000) - 30 * 86400;
	const [monitors, checks, incidents, ongoing, pages, uptime] = await Promise.all([
		env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS active FROM monitors`).first<{ total: number; active: number }>(),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM checks WHERE checked_at >= ?`).bind(since24h).first<{ n: number }>(),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents`).first<{ n: number }>(),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL`).first<{ n: number }>(),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM status_pages`).first<{ n: number }>(),
		env.DB.prepare(`SELECT CAST(100.0 * SUM(ok) / COUNT(*) AS REAL) AS pct FROM checks WHERE checked_at >= ?`).bind(since30d).first<{ pct: number | null }>(),
	]);
	return {
		totalMonitors: monitors?.total ?? 0,
		activeMonitors: monitors?.active ?? 0,
		checks24h: checks?.n ?? 0,
		incidents: incidents?.n ?? 0,
		ongoingIncidents: ongoing?.n ?? 0,
		statusPages: pages?.n ?? 0,
		globalUptimePct: uptime?.pct ?? null,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: incident detail + maintenance windows
// ─────────────────────────────────────────────────────────────────────────────

export async function getIncidentById(env: Env, id: number): Promise<IncidentWithMonitor | null> {
	const row = await env.DB.prepare(
		`SELECT i.*, m.name, m.url FROM incidents i
		 JOIN monitors m ON m.id = i.monitor_id
		 WHERE i.id = ?`
	).bind(id).first<IncidentWithMonitor>();
	return row ?? null;
}

export async function getIncidentUpdates(env: Env, incidentId: number): Promise<IncidentUpdate[]> {
	const res = await env.DB.prepare(
		`SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at ASC`
	).bind(incidentId).all<IncidentUpdate>();
	return res.results ?? [];
}

export async function addIncidentUpdate(
	env: Env,
	incidentId: number,
	message: string,
	author?: string | null
): Promise<{ ok: true; update: IncidentUpdate } | { ok: false; error: string }> {
	const msg = typeof message === 'string' ? message.trim().slice(0, 4000) : '';
	if (!msg) return { ok: false, error: 'Message is required' };
	const incident = await env.DB.prepare(`SELECT id FROM incidents WHERE id = ?`).bind(incidentId).first();
	if (!incident) return { ok: false, error: 'Incident not found' };
	const now = Math.floor(Date.now() / 1000);
	const auth = typeof author === 'string' ? author.trim().slice(0, 120) || null : null;
	const result = await env.DB.prepare(
		`INSERT INTO incident_updates (incident_id, message, author, created_at) VALUES (?, ?, ?, ?)`
	).bind(incidentId, msg, auth, now).run();
	const row = await env.DB.prepare(`SELECT * FROM incident_updates WHERE id = ?`).bind(result.meta.last_row_id).first<IncidentUpdate>();
	try { await logAudit(env, { actor: auth ?? 'admin', action: 'incident.update', target_type: 'incident', target_id: String(incidentId), metadata: msg.slice(0, 500) }); } catch {}
	return { ok: true, update: row! };
}

export async function resolveIncident(env: Env, incidentId: number): Promise<{ ok: true } | { ok: false; error: string }> {
	const incident = await env.DB.prepare(`SELECT * FROM incidents WHERE id = ?`).bind(incidentId).first<Incident>();
	if (!incident) return { ok: false, error: 'Incident not found' };
	if (incident.resolved_at !== null) return { ok: false, error: 'Incident already resolved' };
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(`UPDATE incidents SET resolved_at = ? WHERE id = ?`).bind(now, incidentId).run();
	// also ensure monitor status reflects resolution if this was the open incident
	await env.DB.prepare(
		`UPDATE monitors SET current_status = 'up', consecutive_failures = 0 WHERE id = ? AND current_status = 'down'`
	).bind(incident.monitor_id).run();
	return { ok: true };
}

export interface MaintenanceWindowWithMonitor extends MaintenanceWindow {
	monitor_name: string | null;
	monitor_url: string | null;
}

export async function listMaintenanceWindows(env: Env): Promise<MaintenanceWindowWithMonitor[]> {
	const res = await env.DB.prepare(
		`SELECT mw.*, m.name AS monitor_name, m.url AS monitor_url
		 FROM maintenance_windows mw
		 LEFT JOIN monitors m ON m.id = mw.monitor_id
		 ORDER BY mw.start_at DESC`
	).all<MaintenanceWindowWithMonitor>();
	return res.results ?? [];
}

export interface CreateMaintenanceInput {
	title: string;
	description?: string | null;
	monitor_id?: number | null;
	status_page_id?: number | null;
	start_at: number;
	end_at: number;
}

export async function createMaintenanceWindow(
	env: Env,
	input: CreateMaintenanceInput
): Promise<{ ok: true; window: MaintenanceWindow } | { ok: false; error: string }> {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid maintenance data' };
	const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
	if (!title) return { ok: false, error: 'Title is required' };
	const description = typeof input.description === 'string' ? input.description.trim().slice(0, 2000) || null : null;
	const start_at = Number(input.start_at);
	const end_at = Number(input.end_at);
	if (!Number.isInteger(start_at) || !Number.isInteger(end_at)) return { ok: false, error: 'Start and end must be valid timestamps' };
	if (start_at >= end_at) return { ok: false, error: 'End must be after start' };
	if (end_at - start_at > 60 * 86400) return { ok: false, error: 'Maintenance window too long (max 60 days)' };

	let monitor_id: number | null = null;
	if (input.monitor_id !== undefined && input.monitor_id !== null && String(input.monitor_id) !== '') {
		const mid = Number(input.monitor_id);
		if (!Number.isInteger(mid)) return { ok: false, error: 'Invalid monitor' };
		const exists = await env.DB.prepare(`SELECT id FROM monitors WHERE id = ?`).bind(mid).first();
		if (!exists) return { ok: false, error: 'Monitor not found' };
		monitor_id = mid;
	}

	let status_page_id: number | null = null;
	if (input.status_page_id !== undefined && input.status_page_id !== null && String(input.status_page_id) !== '') {
		const pid = Number(input.status_page_id);
		if (!Number.isInteger(pid)) return { ok: false, error: 'Invalid status page' };
		const exists = await env.DB.prepare(`SELECT id FROM status_pages WHERE id = ?`).bind(pid).first();
		if (!exists) return { ok: false, error: 'Status page not found' };
		status_page_id = pid;
	}

	const now = Math.floor(Date.now() / 1000);
	const result = await env.DB.prepare(
		`INSERT INTO maintenance_windows (title, description, monitor_id, status_page_id, start_at, end_at, enabled, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
	).bind(title, description, monitor_id, status_page_id, start_at, end_at, now).run();
	const row = await env.DB.prepare(`SELECT * FROM maintenance_windows WHERE id = ?`).bind(result.meta.last_row_id).first<MaintenanceWindow>();
	return { ok: true, window: row! };
}

export async function deleteMaintenanceWindow(env: Env, id: number): Promise<boolean> {
	const result = await env.DB.prepare(`DELETE FROM maintenance_windows WHERE id = ?`).bind(id).run();
	return (result.meta.changes ?? 0) === 1;
}

export async function isInMaintenance(env: Env, monitorId: number, nowSec: number): Promise<boolean> {
	const ts = Number(nowSec);
	if (!Number.isInteger(ts)) return false;
	const row = await env.DB.prepare(
		`SELECT 1 AS v FROM maintenance_windows
		 WHERE enabled = 1 AND start_at <= ? AND end_at >= ?
		   AND (monitor_id IS NULL OR monitor_id = ?)
		 LIMIT 1`
	).bind(ts, ts, monitorId).first<{ v: number }>();
	return !!row;
}

export async function getActiveMaintenanceWindows(env: Env, nowSec?: number): Promise<MaintenanceWindowWithMonitor[]> {
	const now = nowSec ?? Math.floor(Date.now() / 1000);
	const res = await env.DB.prepare(
		`SELECT mw.*, m.name AS monitor_name, m.url AS monitor_url
		 FROM maintenance_windows mw
		 LEFT JOIN monitors m ON m.id = mw.monitor_id
		 WHERE mw.enabled = 1 AND mw.start_at <= ? AND mw.end_at >= ?
		 ORDER BY mw.start_at DESC`
	).bind(now, now).all<MaintenanceWindowWithMonitor>();
	return res.results ?? [];
}

export async function getMaintenanceForMonitor(env: Env, monitorId: number, nowSec?: number): Promise<MaintenanceWindow | null> {
	const now = nowSec ?? Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		`SELECT * FROM maintenance_windows
		 WHERE enabled = 1 AND start_at <= ? AND end_at >= ?
		   AND (monitor_id IS NULL OR monitor_id = ?)
		 ORDER BY start_at DESC LIMIT 1`
	).bind(now, now, monitorId).first<MaintenanceWindow>();
	return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: notification channels
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationChannel {
	id: number;
	name: string;
	type: string;
	config: string;
	enabled: number;
	created_at: number;
}

export async function listChannels(env: Env): Promise<NotificationChannel[]> {
	const res = await env.DB.prepare(`SELECT * FROM notification_channels ORDER BY created_at DESC`).all<NotificationChannel>();
	return res.results ?? [];
}

export async function getChannel(env: Env, id: number): Promise<NotificationChannel | null> {
	const row = await env.DB.prepare(`SELECT * FROM notification_channels WHERE id = ?`).bind(id).first<NotificationChannel>();
	return row ?? null;
}

export async function createChannel(
	env: Env,
	input: { name?: unknown; type?: unknown; config?: unknown; enabled?: unknown; url?: unknown; to?: unknown; from?: unknown; endpoint?: unknown }
): Promise<{ ok: true; channel: NotificationChannel } | { ok: false; error: string }> {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid channel data' };
	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
	if (!name) return { ok: false, error: 'Name is required' };
	const typeRaw = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
	const allowed = new Set(['email', 'webhook', 'slack', 'discord']);
	if (!allowed.has(typeRaw)) return { ok: false, error: 'Type must be one of: email, webhook, slack, discord' };

	let configObj: Record<string, unknown> = {};
	if (input.config !== undefined && input.config !== null) {
		if (typeof input.config === 'string') {
			const s = input.config.trim();
			if (s) {
				try {
					const parsed = JSON.parse(s);
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) configObj = parsed as Record<string, unknown>;
					else configObj = { url: s };
				} catch {
					// treat as raw url string
					configObj = { url: s };
				}
			}
		} else if (typeof input.config === 'object' && !Array.isArray(input.config)) {
			configObj = { ...(input.config as Record<string, unknown>) };
		}
	}
	// also merge top-level url/to/from/endpoint if not in config
	if (input.url && !configObj.url && !configObj.webhook_url) configObj.url = String(input.url);
	if (input.to && !configObj.to) configObj.to = String(input.to);
	if (input.from && !configObj.from) configObj.from = String(input.from);
	if (input.endpoint && !configObj.endpoint) configObj.endpoint = String(input.endpoint);

	// basic validation per type
	if (['webhook', 'slack', 'discord'].includes(typeRaw)) {
		const hasUrl = !!(configObj.url || configObj.webhook_url || configObj.webhookUrl);
		if (!hasUrl) return { ok: false, error: 'URL is required for webhook/slack/discord channels' };
		const rawUrl = String(configObj.url ?? configObj.webhook_url ?? configObj.webhookUrl ?? '');
		try {
			const u = new URL(rawUrl);
			if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid');
		} catch {
			return { ok: false, error: 'Invalid URL' };
		}
	}
	if (typeRaw === 'email') {
		const hasRecipient = !!(configObj.to || configObj.email || configObj.recipient || configObj.endpoint || configObj.url);
		if (!hasRecipient) return { ok: false, error: 'Email recipient (to) or endpoint is required' };
	}

	const enabled = input.enabled === 0 || input.enabled === false ? 0 : 1;
	const now = Math.floor(Date.now() / 1000);
	const configStr = JSON.stringify(configObj);
	const result = await env.DB.prepare(
		`INSERT INTO notification_channels (name, type, config, enabled, created_at) VALUES (?, ?, ?, ?, ?)`
	).bind(name, typeRaw, configStr, enabled, now).run();
	const row = await env.DB.prepare(`SELECT * FROM notification_channels WHERE id = ?`).bind(result.meta.last_row_id).first<NotificationChannel>();
	return { ok: true, channel: row! };
}

export async function deleteChannel(env: Env, id: number): Promise<boolean> {
	const result = await env.DB.prepare(`DELETE FROM notification_channels WHERE id = ?`).bind(id).run();
	return (result.meta.changes ?? 0) === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: status pages CRUD
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusPageRow {
	id: number;
	slug: string;
	title: string;
	description: string | null;
	branding_logo_url: string | null;
	branding_theme: string | null;
	custom_domain: string | null;
	is_public: number;
	created_at: number;
}

export async function listStatusPages(env: Env): Promise<StatusPageRow[]> {
	const res = await env.DB.prepare(`SELECT * FROM status_pages ORDER BY created_at DESC`).all<StatusPageRow>();
	return res.results ?? [];
}

export async function getStatusPageById(env: Env, id: number): Promise<StatusPageRow | null> {
	const row = await env.DB.prepare(`SELECT * FROM status_pages WHERE id = ?`).bind(id).first<StatusPageRow>();
	return row ?? null;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48) || 'page';
}

export interface StatusPageInput {
	slug?: string;
	title?: string;
	description?: string | null;
	branding_logo_url?: string | null;
	branding_theme?: string | null;
	custom_domain?: string | null;
	is_public?: number | boolean | string | null;
}

export async function createStatusPage(
	env: Env,
	input: StatusPageInput
): Promise<{ ok: true; page: StatusPageRow } | { ok: false; error: string }> {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid status page data' };
	const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
	if (!title) return { ok: false, error: 'Title is required' };
	let slug = typeof input.slug === 'string' ? slugify(input.slug) : slugify(title);
	if (!slug) return { ok: false, error: 'Slug is required' };
	// ensure slug unique — if conflict append suffix
	const existing = await env.DB.prepare(`SELECT id FROM status_pages WHERE slug = ?`).bind(slug).first();
	if (existing) slug = `${slug}-${randomSuffix(4)}`;

	const description = typeof input.description === 'string' ? input.description.trim().slice(0, 2000) || null : null;
	const branding_logo_url = typeof input.branding_logo_url === 'string' ? input.branding_logo_url.trim().slice(0, 2048) || null : null;
	const branding_theme = typeof input.branding_theme === 'string' ? input.branding_theme.trim().slice(0, 48) || null : null;
	const custom_domain = typeof input.custom_domain === 'string' ? input.custom_domain.trim().slice(0, 253) || null : null;
	let is_public = 1;
	if (input.is_public !== undefined && input.is_public !== null) {
		const v = input.is_public;
		if (v === 0 || v === false || String(v).toLowerCase() === 'false' || String(v) === '0') is_public = 0;
		else is_public = 1;
	}
	if (branding_logo_url) {
		try {
			const u = new URL(branding_logo_url);
			if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Invalid branding logo URL' };
		} catch {
			return { ok: false, error: 'Invalid branding logo URL' };
		}
	}
	const now = Math.floor(Date.now() / 1000);
	try {
		const result = await env.DB.prepare(
			`INSERT INTO status_pages (slug, title, description, branding_logo_url, branding_theme, custom_domain, is_public, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(slug, title, description, branding_logo_url, branding_theme, custom_domain, is_public, now).run();
		const row = await env.DB.prepare(`SELECT * FROM status_pages WHERE id = ?`).bind(result.meta.last_row_id).first<StatusPageRow>();
		return { ok: true, page: row! };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes('UNIQUE') || msg.includes('unique')) return { ok: false, error: 'Slug already exists' };
		return { ok: false, error: msg };
	}
}

export async function updateStatusPage(
	env: Env,
	id: number,
	input: StatusPageInput
): Promise<{ ok: true; page: StatusPageRow } | { ok: false; error: string }> {
	const existing = await getStatusPageById(env, id);
	if (!existing) return { ok: false, error: 'Status page not found' };

	const updates: string[] = [];
	const values: unknown[] = [];

	if (input.title !== undefined) {
		const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
		if (!title) return { ok: false, error: 'Title is required' };
		updates.push('title = ?');
		values.push(title);
	}
	if (input.slug !== undefined) {
		const slug = typeof input.slug === 'string' ? slugify(input.slug) : '';
		if (!slug) return { ok: false, error: 'Invalid slug' };
		if (slug !== existing.slug) {
			const conflict = await env.DB.prepare(`SELECT id FROM status_pages WHERE slug = ? AND id != ?`).bind(slug, id).first();
			if (conflict) return { ok: false, error: 'Slug already exists' };
		}
		updates.push('slug = ?');
		values.push(slug);
	}
	if (input.description !== undefined) {
		const description = typeof input.description === 'string' ? input.description.trim().slice(0, 2000) || null : null;
		updates.push('description = ?');
		values.push(description);
	}
	if (input.branding_logo_url !== undefined) {
		const branding_logo_url = typeof input.branding_logo_url === 'string' ? input.branding_logo_url.trim().slice(0, 2048) || null : null;
		if (branding_logo_url) {
			try {
				const u = new URL(branding_logo_url);
				if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Invalid branding logo URL' };
			} catch {
				return { ok: false, error: 'Invalid branding logo URL' };
			}
		}
		updates.push('branding_logo_url = ?');
		values.push(branding_logo_url);
	}
	if (input.branding_theme !== undefined) {
		const branding_theme = typeof input.branding_theme === 'string' ? input.branding_theme.trim().slice(0, 48) || null : null;
		updates.push('branding_theme = ?');
		values.push(branding_theme);
	}
	if (input.custom_domain !== undefined) {
		const custom_domain = typeof input.custom_domain === 'string' ? input.custom_domain.trim().slice(0, 253) || null : null;
		updates.push('custom_domain = ?');
		values.push(custom_domain);
	}
	if (input.is_public !== undefined) {
		let is_public = 1;
		const v = input.is_public;
		if (v === 0 || v === false || String(v).toLowerCase() === 'false' || String(v) === '0') is_public = 0;
		updates.push('is_public = ?');
		values.push(is_public);
	}

	if (updates.length === 0) return { ok: true, page: existing };

	values.push(id);
	try {
		await env.DB.prepare(`UPDATE status_pages SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
		const row = await getStatusPageById(env, id);
		return { ok: true, page: row! };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function deleteStatusPage(env: Env, id: number): Promise<{ ok: true } | { ok: false; error: string }> {
	const existing = await getStatusPageById(env, id);
	if (!existing) return { ok: false, error: 'Status page not found' };
	// protect default page from accidental deletion if it's the only one; allow but ensure fallback still works
	if (existing.slug === 'default') {
		const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM status_pages`).first<{ n: number }>();
		if ((count?.n ?? 0) <= 1) return { ok: false, error: 'Cannot delete the default status page' };
	}
	const result = await env.DB.prepare(`DELETE FROM status_pages WHERE id = ?`).bind(id).run();
	if ((result.meta.changes ?? 0) !== 1) return { ok: false, error: 'Delete failed' };
	return { ok: true };
}

export async function setPageMonitors(env: Env, pageId: number, monitorIds: number[]): Promise<{ ok: true } | { ok: false; error: string }> {
	const page = await getStatusPageById(env, pageId);
	if (!page) return { ok: false, error: 'Status page not found' };
	if (!Array.isArray(monitorIds)) return { ok: false, error: 'monitorIds must be an array' };
	// validate ids are integers and exist
	const clean: number[] = [];
	for (const raw of monitorIds) {
		const n = Number(raw);
		if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `Invalid monitor id: ${raw}` };
		if (clean.includes(n)) return { ok: false, error: `Duplicate monitor id: ${n}` };
		clean.push(n);
	}
	if (clean.length > 0) {
		// verify all monitors exist
		const placeholders = clean.map(() => '?').join(',');
		const rows = await env.DB.prepare(`SELECT id FROM monitors WHERE id IN (${placeholders})`).bind(...clean).all<{ id: number }>();
		const found = new Set((rows.results ?? []).map((r) => r.id));
		for (const id of clean) if (!found.has(id)) return { ok: false, error: `Monitor not found: ${id}` };
	}

	// atomic replacement via batch
	const statements: D1PreparedStatement[] = [];
	statements.push(env.DB.prepare(`DELETE FROM status_page_monitors WHERE page_id = ?`).bind(pageId));
	for (let i = 0; i < clean.length; i++) {
		statements.push(env.DB.prepare(`INSERT INTO status_page_monitors (page_id, monitor_id, sort_order) VALUES (?, ?, ?)`).bind(pageId, clean[i], i));
	}
	if (statements.length === 1) {
		await statements[0].run();
	} else {
		await env.DB.batch(statements);
	}
	return { ok: true };
}

export async function getStatusPageMonitorIds(env: Env, pageId: number): Promise<number[]> {
	const res = await env.DB.prepare(`SELECT monitor_id FROM status_page_monitors WHERE page_id = ? ORDER BY sort_order ASC`).bind(pageId).all<{ monitor_id: number }>();
	return (res.results ?? []).map((r) => r.monitor_id);
}
