// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	// Canonical origin for absolute URLs (canonical tags, og:url, sitemap, robots).
	// Override per deployment with PUBLIC_SITE_URL at build time.
	site: process.env.PUBLIC_SITE_URL ?? 'https://uptimecove.com',
	output: 'server',
	adapter: cloudflare(),
	vite: {
		plugins: [tailwindcss()],
		server: {
			watch: {
				// D1/KV state files change on every query — never restart the app for them
				ignored: ['**/.wrangler/**', '**/.astro/**'],
			},
		},
	},
});
