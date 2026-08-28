import astroServer from '@astrojs/cloudflare/entrypoints/server';
import { runDueChecks, pruneOldChecks } from './lib/monitor';
import { cleanupExpiredSessions } from './lib/sessions';
import { runHeartbeatChecks } from './lib/heartbeat';

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

				// Heartbeat (dead-man's-switch) monitors are evaluated on the same
				// tick. A failure here must not hide the outbound-check result, so
				// it is reported separately and its errors are swallowed.
				try {
					const hb = await runHeartbeatChecks(env, Math.floor(event.scheduledTime / 1000), ctx);
					if (hb.checked > 0) {
						console.log(`[uptimecove] cron ${event.cron}: heartbeats checked ${hb.checked}, failed ${hb.failed}`);
					}
				} catch (err) {
					console.error('[uptimecove] heartbeat sweep failed', err);
				}
			})()
		);
	},
};
