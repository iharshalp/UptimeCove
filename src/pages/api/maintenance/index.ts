import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listMaintenanceWindows, createMaintenanceWindow } from '../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async () => {
	const windows = await listMaintenanceWindows(env);
	return json({ windows });
};

export const POST: APIRoute = async ({ request }) => {
	const ct = request.headers.get('content-type') ?? '';
	let input: Record<string, unknown> = {};
	try {
		if (ct.includes('application/json')) {
			input = (await request.json()) as Record<string, unknown>;
		} else {
			const form = await request.formData();
			input = {
				title: String(form.get('title') ?? ''),
				description: String(form.get('description') ?? ''),
				monitor_id: form.get('monitor_id') ? String(form.get('monitor_id')) : null,
				start_at: String(form.get('start_at') ?? ''),
				end_at: String(form.get('end_at') ?? ''),
			};
			// datetime-local handling: if values contain 'T', parse as local ISO
			for (const k of ['start_at', 'end_at'] as const) {
				const v = input[k];
				if (typeof v === 'string' && v.includes('T')) {
					const ms = Date.parse(v);
					if (!Number.isNaN(ms)) input[k] = Math.floor(ms / 1000);
				}
			}
		}
	} catch {
		return json({ error: 'Invalid body' }, 400);
	}

	// Normalize numeric timestamps: accept ISO strings or seconds
	let start_at: number | undefined;
	let end_at: number | undefined;
	for (const key of ['start_at', 'end_at'] as const) {
		const val = input[key];
		if (typeof val === 'number') {
			if (key === 'start_at') start_at = val;
			else end_at = val;
		} else if (typeof val === 'string') {
			if (val === '') continue;
			// try ISO datetime first (e.g. 2026-08-26T10:00)
			if (val.includes('T') || val.includes('-')) {
				const ms = Date.parse(val);
				if (!Number.isNaN(ms)) {
					if (key === 'start_at') start_at = Math.floor(ms / 1000);
					else end_at = Math.floor(ms / 1000);
					continue;
				}
			}
			const n = Number(val);
			if (Number.isFinite(n)) {
				if (key === 'start_at') start_at = n;
				else end_at = n;
			}
		}
	}

	if (start_at === undefined || end_at === undefined) {
		return json({ error: 'Start and end are required' }, 400);
	}

	const monitor_id = input.monitor_id === '' || input.monitor_id === null || input.monitor_id === undefined ? null : Number(input.monitor_id);

	const result = await createMaintenanceWindow(env, {
		title: String(input.title ?? ''),
		description: input.description ? String(input.description) : null,
		monitor_id,
		status_page_id: input.status_page_id ? Number(input.status_page_id) : null,
		start_at,
		end_at,
	});

	if (!result.ok) return json({ error: result.error }, 400);

	// If form post (non-json), redirect back to maintenance page
	if (!ct.includes('application/json')) {
		return Response.redirect(new URL('/dashboard/maintenance', request.url), 303);
	}
	return json({ window: result.window }, 201);
};
