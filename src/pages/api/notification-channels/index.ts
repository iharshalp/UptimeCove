import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listChannels, createChannel } from '../../../lib/queries';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async () => {
	const channels = await listChannels(env);
	return json({ channels });
};

export const POST: APIRoute = async ({ request }) => {
	let body: Record<string, unknown> = {};
	const ctype = request.headers.get('content-type') ?? '';
	try {
		if (ctype.includes('application/json')) {
			body = (await request.json()) as Record<string, unknown>;
		} else if (ctype.includes('application/x-www-form-urlencoded') || ctype.includes('multipart/form-data')) {
			const form = await request.formData();
			for (const [k, v] of form.entries()) body[k] = String(v);
			// try parse config json if present
			if (body.config && typeof body.config === 'string') {
				try {
					body.config = JSON.parse(body.config as string);
				} catch {
					// keep as string
				}
			}
		} else {
			// attempt json fallback
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				body = {};
			}
		}
	} catch {
		return json({ error: 'Invalid JSON body' }, 400);
	}

	// normalize config: support top-level url etc.
	// if config is missing but url/to present, createChannel will handle merging
	const result = await createChannel(env, body as { name?: unknown; type?: unknown; config?: unknown; enabled?: unknown; url?: unknown; to?: unknown; from?: unknown; endpoint?: unknown });
	if (!result.ok) return json({ error: result.error }, 400);
	return json({ channel: result.channel }, 201);
};
