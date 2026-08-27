const SESSION_TTL_SECONDS = 7 * 24 * 3600;

function hashToken(token: string): string {
	// Simple hash for storage comparison, not for password hashing
	let h = 0;
	for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
	return h.toString(16);
}

export async function createSession(env: Env): Promise<{ id: string; expiresAt: number }> {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = now + SESSION_TTL_SECONDS;
	const tokenHash = hashToken(env.ADMIN_TOKEN ?? '');
	await env.DB.prepare(`INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)`).bind(id, tokenHash, expiresAt, now).run();
	return { id, expiresAt };
}

export async function validateSession(env: Env, sessionId: string): Promise<boolean> {
	if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 10) return false;
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(`SELECT expires_at, token_hash FROM sessions WHERE id = ?`).bind(sessionId).first<{ expires_at: number; token_hash: string }>();
	if (!row) return false;
	if (row.expires_at < now) {
		await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run().catch(() => {});
		return false;
	}
	// Ensure session was created for current ADMIN_TOKEN (handles rotation)
	const currentHash = hashToken(env.ADMIN_TOKEN ?? '');
	if (row.token_hash !== currentHash) return false;
	return true;
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
	if (!sessionId) return;
	await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run().catch(() => {});
}

export async function cleanupExpiredSessions(env: Env): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const res = await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run();
	return res.meta.changes ?? 0;
}
