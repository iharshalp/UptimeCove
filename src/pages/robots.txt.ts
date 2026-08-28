import type { APIRoute } from 'astro';

/**
 * robots.txt
 *
 * Public marketing/legal pages are crawlable. The dashboard, auth routes and
 * write APIs are not — they are behind auth anyway, but keeping crawlers out
 * avoids wasted crawl budget and stray 401s in Search Console.
 *
 * Each deployment gets its own origin, so Sitemap: is built from the request
 * rather than hard-coded.
 */
export const GET: APIRoute = ({ site, url }) => {
	const origin = site?.origin ?? url.origin;

	const body = `# UptimeCove — https://github.com/iharshalp/UptimeCove
User-agent: *
Allow: /$
Allow: /docs
Allow: /about
Allow: /contact
Allow: /privacy
Allow: /terms
Allow: /status/

# Private / non-indexable surfaces
Disallow: /dashboard
Disallow: /dashboard/
Disallow: /login
Disallow: /api/

# The demo renders the dashboard with sample data — it carries a noindex tag,
# so keep it out of the crawl instead of sending mixed signals.
Disallow: /demo

# Public read-only API endpoints are fine to fetch but not worth indexing
Disallow: /api/status
Disallow: /api/badge

Sitemap: ${origin}/sitemap.xml
`;

	return new Response(body, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'public, max-age=3600',
		},
	});
};
