import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { recordPing } from '../../../../lib/heartbeat';

/**
 * Heartbeat ping (dead-man's-switch).
 *
 * A cron job, backup script or worker calls this after it finishes. Each ping
 * marks the monitor up and resolves any open incident; if no ping arrives
 * within the monitor's grace period, the scheduled worker opens one.
 *
 * Deliberately unauthenticated — the URL is the credential, which is what makes
 * it usable from `curl` in a crontab. GET is accepted for the same reason
 * (`curl <url>` with no flags); HEAD comes along for free.
 */
async function handlePing(idParam: string | undefined, request: Request): Promise<Response> {
	const id = Number(idParam);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'Invalid heartbeat id' }, 400);
	}

	const sourceIp =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		null;

	const result = await recordPing(env, id, sourceIp);
	if (!result.ok) {
		return json({ error: result.error }, 404);
	}

	return json({ ok: true, pinged_at: result.pinged_at });
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			// Never let a proxy or browser cache a ping response — a cached 200
			// would silently stop the ping from ever reaching the database.
			'cache-control': 'no-store',
		},
	});
}

export const POST: APIRoute = ({ params, request }) => handlePing(params.id, request);
export const GET: APIRoute = ({ params, request }) => handlePing(params.id, request);
