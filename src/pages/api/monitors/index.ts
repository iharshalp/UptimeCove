import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createMonitor, type MonitorInput } from '../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const POST: APIRoute = async ({ request }) => {
	const contentType = request.headers.get('content-type') ?? '';

	let input: Partial<MonitorInput>;

	if (contentType.includes('application/json')) {
		try {
			input = (await request.json()) as Partial<MonitorInput>;
		} catch {
			return json({ error: 'Invalid JSON body' }, 400);
		}
	} else {
		const form = await request.formData();
		input = {
			name: String(form.get('name') ?? ''),
			url: String(form.get('url') ?? ''),
			interval_seconds: Number(form.get('interval_seconds')) || undefined,
		};
		if (!input.name || !input.url) {
			return Response.redirect(new URL('/dashboard', request.url), 303);
		}
	}

	const result = await createMonitor(env, {
		name: String(input.name ?? ''),
		url: String(input.url ?? ''),
		method: input.method ? String(input.method) : undefined,
		expected_status: input.expected_status ? Number(input.expected_status) : undefined,
		interval_seconds: input.interval_seconds ? Number(input.interval_seconds) : undefined,
		timeout_ms: input.timeout_ms ? Number(input.timeout_ms) : undefined,
		body_must_contain: input.body_must_contain === null ? null : input.body_must_contain !== undefined ? String(input.body_must_contain) : undefined,
		body_must_not_contain: input.body_must_not_contain === null ? null : input.body_must_not_contain !== undefined ? String(input.body_must_not_contain) : undefined,
		max_response_time_ms: input.max_response_time_ms === null ? null : input.max_response_time_ms !== undefined ? (input.max_response_time_ms as unknown as number) : undefined,
		custom_headers: input.custom_headers === null ? null : input.custom_headers !== undefined ? String(input.custom_headers) : undefined,
		check_regions: (input as unknown as { check_regions?: string | null }).check_regions === null ? null : (input as unknown as { check_regions?: string }).check_regions !== undefined ? String((input as unknown as { check_regions?: string }).check_regions) : undefined,
	});

	if (!contentType.includes('application/json')) {
		if (!result.ok) {
			return Response.redirect(new URL(`/login?error=${encodeURIComponent(result.error)}&next=${encodeURIComponent('/dashboard')}`, request.url), 303);
		}
		return Response.redirect(new URL('/dashboard', request.url), 303);
	}
	return result.ok ? json({ monitor: result.monitor }, 201) : json({ error: result.error }, 400);
};
