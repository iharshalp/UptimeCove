import type { Monitor, Incident } from '../types';

export type ChannelType = 'email' | 'webhook' | 'slack' | 'discord';
export type NotificationEvent = 'open' | 'recovered';

export interface NotificationChannelRow {
	id: number;
	name: string;
	type: string;
	config: string;
	enabled: number;
	created_at: number;
}

export interface NotificationDeliveryRow {
	id: number;
	channel_id: number;
	incident_id: number | null;
	monitor_id: number | null;
	event: string;
	payload: string | null;
	status: string;
	error: string | null;
	created_at: number;
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function safeJsonParse(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		return {};
	} catch {
		return {};
	}
}

function buildText(monitor: Monitor, incident: Incident | Record<string, unknown>, event: NotificationEvent): string {
	const cause = (incident as Incident).cause ?? (incident as Record<string, unknown>).cause ?? 'Check failed';
	if (event === 'open') {
		return `🔴 ${monitor.name} is DOWN — ${cause} — ${monitor.url}`;
	}
	return `🟢 ${monitor.name} recovered — ${monitor.url}`;
}

function buildPayloads(monitor: Monitor, incident: Incident | Record<string, unknown>, event: NotificationEvent) {
	const text = buildText(monitor, incident, event);
	const ts = new Date().toISOString();
	const cause = (incident as Incident).cause ?? (incident as Record<string, unknown>).cause ?? 'Check failed';
	const incidentId = (incident as Incident).id ?? (incident as Record<string, unknown>).id ?? null;
	const startedAt = (incident as Incident).started_at ?? (incident as Record<string, unknown>).started_at ?? null;
	const resolvedAt = (incident as Incident).resolved_at ?? (incident as Record<string, unknown>).resolved_at ?? null;

	return {
		text,
		webhook: {
			event,
			monitor: { id: monitor.id, name: monitor.name, url: monitor.url, slug: monitor.slug },
			incident: { id: incidentId, cause, started_at: startedAt, resolved_at: resolvedAt },
			message: text,
			timestamp: ts,
		},
		slack: {
			text,
			attachments: [
				{
					color: event === 'open' ? 'danger' : 'good',
					title: monitor.name,
					title_link: monitor.url,
					text: String(cause),
					fields: [
						{ title: 'Status', value: event === 'open' ? 'Incident opened' : 'Recovered', short: true },
						{ title: 'URL', value: monitor.url, short: false },
					],
					ts: Math.floor(Date.now() / 1000),
				},
			],
		},
		discord: {
			content: text,
			embeds: [
				{
					title: `${monitor.name} — ${event === 'open' ? 'Incident opened' : 'Recovered'}`,
					description: String(cause),
					color: event === 'open' ? 0xef4444 : 0x10b981,
					fields: [
						{ name: 'URL', value: monitor.url, inline: false },
						{ name: 'Event', value: event, inline: true },
						{ name: 'Time', value: ts, inline: true },
					],
					timestamp: ts,
				},
			],
		},
		email: (config: Record<string, unknown>) => ({
			from: (config.from as string) ?? (config.from_email as string) ?? 'noreply@uptimecove.local',
			to: (config.to as string) ?? (config.email as string) ?? (config.recipient as string) ?? '',
			subject: event === 'open' ? `🔴 ${monitor.name} is down` : `🟢 ${monitor.name} recovered`,
			text,
			html: `<p>${text}</p><p><a href="${monitor.url}">${monitor.url}</a></p><p>Cause: ${String(cause)}</p><p>Event: ${event} at ${ts}</p>`,
		}),
	};
}

async function recordDelivery(
	env: Env,
	channelId: number,
	incident: Incident | Record<string, unknown>,
	monitor: Monitor,
	event: NotificationEvent,
	payload: unknown,
	status: string,
	error: string | null,
) {
	const incidentId = ((incident as Incident).id ?? (incident as Record<string, unknown>).id) as number | null | undefined;
	const monitorId = monitor.id;
	const payloadStr = payload ? JSON.stringify(payload) : null;
	const createdAt = nowSec();
	try {
		await env.DB.prepare(
			`INSERT INTO notification_deliveries (channel_id, incident_id, monitor_id, event, payload, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(channelId, incidentId ?? null, monitorId, event, payloadStr, status, error, createdAt)
			.run();
	} catch (e) {
		console.error('[notifications] failed to record delivery', e);
	}
}

async function sendToChannel(
	env: Env,
	channel: NotificationChannelRow,
	monitor: Monitor,
	incident: Incident | Record<string, unknown>,
	event: NotificationEvent,
): Promise<void> {
	const config = safeJsonParse(channel.config);
	const payloads = buildPayloads(monitor, incident, event);
	let payload: unknown = null;
	let url: string | null = null;

	try {
		const type = String(channel.type).toLowerCase() as ChannelType;

		if (type === 'webhook') {
			url = (config.url as string) ?? (config.webhook_url as string) ?? (config.webhookUrl as string) ?? null;
			if (!url) throw new Error('Missing webhook url in channel config');
			payload = payloads.webhook;
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(config.headers as Record<string, string> | undefined) },
				body: JSON.stringify(payload),
			});
			if (!res.ok) throw new Error(`Webhook returned ${res.status} ${res.statusText}`);
			await recordDelivery(env, channel.id, incident, monitor, event, payload, 'sent', null);
			return;
		}

		if (type === 'slack') {
			url = (config.url as string) ?? (config.webhook_url as string) ?? (config.webhookUrl as string) ?? null;
			if (!url) throw new Error('Missing slack webhook url in channel config');
			payload = payloads.slack;
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) throw new Error(`Slack returned ${res.status} ${res.statusText}`);
			await recordDelivery(env, channel.id, incident, monitor, event, payload, 'sent', null);
			return;
		}

		if (type === 'discord') {
			url = (config.url as string) ?? (config.webhook_url as string) ?? (config.webhookUrl as string) ?? null;
			if (!url) throw new Error('Missing discord webhook url in channel config');
			payload = payloads.discord;
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) throw new Error(`Discord returned ${res.status} ${res.statusText}`);
			await recordDelivery(env, channel.id, incident, monitor, event, payload, 'sent', null);
			return;
		}

		if (type === 'email') {
			const emailPayload = payloads.email(config);
			payload = emailPayload;
			if (!emailPayload.to) throw new Error('Missing email recipient (config.to)');

			// Try Cloudflare Email binding if available
			// @ts-ignore - Cloudflare Email binding is optional and untyped
			const emailBinding = (env as Record<string, unknown>).EMAIL ?? (env as Record<string, unknown>).MAIL ?? (env as Record<string, unknown>).SEB;
			if (emailBinding && typeof (emailBinding as Record<string, unknown>).send === 'function') {
				try {
					// Cloudflare Email binding typically exposes send()
					// Support both { from, to, subject, text } shapes
					await (emailBinding as { send: (msg: unknown) => Promise<unknown> }).send({
						from: emailPayload.from,
						to: emailPayload.to,
						subject: emailPayload.subject,
						text: emailPayload.text,
						html: emailPayload.html,
					});
					await recordDelivery(env, channel.id, incident, monitor, event, payload, 'sent', null);
					return;
				} catch (e) {
					throw new Error(`Email binding failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			}

			// Generic fetch to configured endpoint
			const endpoint = (config.endpoint as string) ?? (config.url as string) ?? (config.webhook_url as string) ?? null;
			if (endpoint) {
				const headers: Record<string, string> = { 'content-type': 'application/json' };
				if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;
				if (config.api_key) headers['authorization'] = `Bearer ${config.api_key}`;
				if (config.headers && typeof config.headers === 'object') Object.assign(headers, config.headers as Record<string, string>);
				const res = await fetch(endpoint, {
					method: 'POST',
					headers,
					body: JSON.stringify(emailPayload),
				});
				if (!res.ok) throw new Error(`Email endpoint returned ${res.status} ${res.statusText}`);
				await recordDelivery(env, channel.id, incident, monitor, event, payload, 'sent', null);
				return;
			}

			throw new Error('No email endpoint or Cloudflare Email binding configured');
		}

		throw new Error(`Unknown channel type: ${channel.type}`);
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		console.error(`[notifications] channel ${channel.id} (${channel.type}) failed:`, errMsg);
		// Record failure with the payload attempted (if any) else null
		await recordDelivery(env, channel.id, incident, monitor, event, payload, 'failed', errMsg);
	}
}

export async function sendNotification(
	env: Env,
	monitor: Monitor,
	incident: Incident | Record<string, unknown>,
	event: NotificationEvent,
): Promise<void> {
	try {
		const res = await env.DB.prepare(`SELECT * FROM notification_channels WHERE enabled = 1`).all<NotificationChannelRow>();
		const channels = res.results ?? [];
		if (channels.length === 0) return;

		// Sequential to avoid overwhelming fetch, but allow parallel via Promise.allSettled
		// Keep it simple: sequential to keep D1 delivery inserts ordered
		for (const ch of channels) {
			await sendToChannel(env, ch, monitor, incident, event);
		}
	} catch (e) {
		console.error('[notifications] sendNotification failed', e);
	}
}
