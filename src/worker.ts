import astroServer from '@astrojs/cloudflare/entrypoints/server';
import { runDueChecks, pruneOldChecks } from './lib/monitor';
import { cleanupExpiredSessions } from './lib/sessions';

interface ScheduledController {
	cron: string;
	scheduledTime: number;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}

export default {
	fetch: astroServer.fetch,

	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			(async () => {
				if (event.cron === '30 3 * * *') {
					const pruned = await pruneOldChecks(env);
					const cleaned = await cleanupExpiredSessions(env);
					console.log(`[uptimecove] retention: pruned ${pruned} check(s), cleaned ${cleaned} sessions`);
					return;
				}
				const result = await runDueChecks(env, event.scheduledTime, false, ctx);
				console.log(`[uptimecove] cron ${event.cron}: checked ${result.checked}, failed ${result.failed}`);
			})()
		);
	},
};
