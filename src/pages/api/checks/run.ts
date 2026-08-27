import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { runDueChecks } from '../../../lib/monitor';

export const POST: APIRoute = async () => {
	const result = await runDueChecks(env, Date.now(), true);
	return new Response(JSON.stringify(result), {
		headers: { 'content-type': 'application/json' },
	});
};
