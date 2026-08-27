import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getStatusPage, getPageMonitors, getDailyUptime } from '../../../lib/queries';

export const GET: APIRoute = async ({ params }) => {
	const slug = (params.slug ?? 'default') as string;

	const page = await getStatusPage(env, slug);
	if (!page) {
		return new Response(JSON.stringify({ error: 'Not found' }), {
			status: 404,
			headers: { 'content-type': 'application/json' },
		});
	}

	const monitors = await getPageMonitors(env, page.id as number);
	const data = await Promise.all(
		monitors.map(async (m) => ({
			id: m.id,
			name: m.name,
			url: m.url,
			status: m.current_status,
			lastCheckedAt: m.last_checked_at,
			dailyUptime: await getDailyUptime(env, m.id),
		}))
	);

	return new Response(JSON.stringify({ page: slug, monitors: data }), {
		headers: {
			'content-type': 'application/json',
			'access-control-allow-origin': '*',
			'cache-control': 'no-store, max-age=0',
		},
	});
};
