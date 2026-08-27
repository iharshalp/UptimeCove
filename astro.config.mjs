// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
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
