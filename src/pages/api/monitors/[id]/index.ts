import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getMonitorById, updateMonitor } from '../../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	const monitor = await getMonitorById(env, id);
	if (!monitor) return json({ error: 'Monitor not found' }, 404);
	return json({ monitor });
};

async function handleUpdate(request: Request, params: Record<string, string | undefined>): Promise<Response> {
	const id = Number(params.id);
	if (!Number.isInteger(id)) return json({ error: 'Invalid id' }, 400);
	const contentType = request.headers.get('content-type') ?? '';
	let input: Record<string, unknown> = {};
	if (contentType.includes('application/json')) {
		try {
			input = (await request.json()) as Record<string, unknown>;
		} catch {
			return json({ error: 'Invalid JSON body' }, 400);
		}
	} else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
		const form = await request.formData();
		for (const [k, v] of form.entries()) input[k] = String(v);
		// normalize numbers
		if (input.expected_status !== undefined) input.expected_status = Number(input.expected_status);
		if (input.timeout_ms !== undefined) input.timeout_ms = Number(input.timeout_ms);
		if (input.interval_seconds !== undefined) input.interval_seconds = Number(input.interval_seconds);
		if (input.max_response_time_ms !== undefined && input.max_response_time_ms !== '' && input.max_response_time_ms !== null) input.max_response_time_ms = Number(input.max_response_time_ms);
	} else {
		try {
			const text = await request.text();
			if (text) input = JSON.parse(text);
		} catch {
			return json({ error: 'Invalid body' }, 400);
		}
	}

	// Map max_response_time to max_response_time_ms if provided without _ms suffix
	if (input.max_response_time !== undefined && input.max_response_time_ms === undefined) {
		input.max_response_time_ms = input.max_response_time;
	}

	const result = await updateMonitor(env, id, {
		name: input.name as string,
		url: input.url as string,
		method: input.method as string | undefined,
		expected_status: input.expected_status as number | undefined,
		interval_seconds: input.interval_seconds as number | undefined,
		timeout_ms: input.timeout_ms as number | undefined,
		body_must_contain: input.body_must_contain as string | null | undefined,
		body_must_not_contain: input.body_must_not_contain as string | null | undefined,
		max_response_time_ms: input.max_response_time_ms as unknown as number | string | null | undefined,
		custom_headers: input.custom_headers as string | null | undefined,
		check_regions: input.check_regions as string | null | undefined,
	});

	if (!result.ok) {
		const status = result.error === 'Monitor not found' ? 404 : 400;
		return json({ error: result.error }, status);
	}
	return json({ monitor: result.monitor });
}

export const PUT: APIRoute = async ({ request, params }) => handleUpdate(request, params as Record<string, string | undefined>);
export const PATCH: APIRoute = async ({ request, params }) => handleUpdate(request, params as Record<string, string | undefined>);
export const POST: APIRoute = async ({ request, params }) => handleUpdate(request, params as Record<string, string | undefined>);
