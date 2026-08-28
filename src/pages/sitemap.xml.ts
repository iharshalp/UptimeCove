import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface SitemapEntry {
	loc: string;
	changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
	priority: string;
	lastmod?: string;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * sitemap.xml
 *
 * Astro runs in `output: 'server'` mode, so @astrojs/sitemap would only see
 * prerendered routes. Building it here instead lets us include the public
 * status pages that live in D1 and change at runtime.
 */
export const GET: APIRoute = async ({ site, url }) => {
	const origin = site?.origin ?? url.origin;

	// /demo and /dashboard are intentionally absent — they carry a noindex tag,
	// and listing a noindex URL here just sends search engines mixed signals.
	const entries: SitemapEntry[] = [
		{ loc: '/', changefreq: 'weekly', priority: '1.0' },
		{ loc: '/docs', changefreq: 'monthly', priority: '0.8' },
		{ loc: '/about', changefreq: 'monthly', priority: '0.6' },
		{ loc: '/contact', changefreq: 'monthly', priority: '0.5' },
		{ loc: '/privacy', changefreq: 'yearly', priority: '0.3' },
		{ loc: '/terms', changefreq: 'yearly', priority: '0.3' },
	];

	// Public status pages are real indexable content — include them when reachable.
	// A DB hiccup must not take the sitemap down, so fall back to the static list.
	try {
		const res = await env.DB.prepare(
			`SELECT slug, created_at FROM status_pages WHERE is_public = 1 ORDER BY created_at DESC LIMIT 500`
		).all<{ slug: string; created_at: number }>();

		for (const page of res.results ?? []) {
			if (!page.slug) continue;
			entries.push({
				loc: `/status/${page.slug}`,
				changefreq: 'daily',
				priority: '0.9',
				lastmod: new Date(page.created_at * 1000).toISOString().slice(0, 10),
			});
		}
	} catch (err) {
		console.error('[sitemap] could not list status pages', err);
	}

	const urls = entries
		.map((entry) => {
			const loc = escapeXml(new URL(entry.loc, origin).href);
			const lastmod = entry.lastmod ? `\n\t\t<lastmod>${entry.lastmod}</lastmod>` : '';
			return `\t<url>\n\t\t<loc>${loc}</loc>${lastmod}\n\t\t<changefreq>${entry.changefreq}</changefreq>\n\t\t<priority>${entry.priority}</priority>\n\t</url>`;
		})
		.join('\n');

	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

	return new Response(xml, {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': 'public, max-age=3600',
		},
	});
};
