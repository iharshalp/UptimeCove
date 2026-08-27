/** Phase 2 helpers: organizations, users, memberships, api keys, audit logs, roles */
export const VALID_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = typeof VALID_ROLES[number];

export function isValidRole(role: string): role is Role {
	return (VALID_ROLES as readonly string[]).includes(role);
}

export function roleLevel(role: string): number {
	const order: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
	return order[role] ?? -1;
}

export interface Organization {
	id: string;
	name: string;
	slug: string;
	created_at: number;
}

export interface User {
	id: string;
	email: string;
	display_name: string | null;
	password_hash: string | null;
	created_at: number;
}

export interface Membership {
	organization_id: string;
	user_id: string;
	role: string;
}

export interface ApiKeyRow {
	id: string;
	name: string;
	key_hash: string;
	scopes: string;
	last_used_at: number | null;
	created_at: number;
}

export interface AuditLog {
	id: number;
	actor: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	metadata: string | null;
	created_at: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// utils
// ─────────────────────────────────────────────────────────────────────────────

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48) || 'org';
}

export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function hashApiKey(key: string): Promise<string> {
	return sha256Hex(key);
}

function generatePlainKey(): string {
	// Use crypto.randomUUID + random bytes for entropy
	const uuidPart = typeof crypto.randomUUID === 'function' ? crypto.randomUUID().replace(/-/g, '') : '';
	const bytes = new Uint8Array(24);
	try {
		crypto.getRandomValues(bytes);
	} catch {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	return `uc_${uuidPart}${hex}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Organizations
// ─────────────────────────────────────────────────────────────────────────────

export async function createOrganization(
	env: Env,
	input: { name?: unknown; slug?: unknown }
): Promise<{ ok: true; organization: Organization } | { ok: false; error: string }> {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid organization data' };
	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
	if (!name) return { ok: false, error: 'Name is required' };
	let slug = typeof input.slug === 'string' && input.slug.trim() ? slugify(input.slug) : slugify(name);
	if (!slug) return { ok: false, error: 'Slug is required' };
	// Ensure unique slug
	const existing = await env.DB.prepare(`SELECT id FROM organizations WHERE slug = ?`).bind(slug).first();
	if (existing) {
		// append short suffix
		const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (v) => (v % 36).toString(36)).join('');
		slug = `${slug}-${suffix}`;
		// double check uniqueness
		const again = await env.DB.prepare(`SELECT id FROM organizations WHERE slug = ?`).bind(slug).first();
		if (again) slug = `${slug}-${Date.now().toString(36)}`;
	}
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	try {
		await env.DB.prepare(`INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)`).bind(id, name, slug, now).run();
		const row = await env.DB.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(id).first<Organization>();
		return { ok: true, organization: row! };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes('UNIQUE') || msg.includes('unique')) return { ok: false, error: 'Slug already exists' };
		return { ok: false, error: msg };
	}
}

export async function listOrganizations(env: Env): Promise<Organization[]> {
	const res = await env.DB.prepare(`SELECT * FROM organizations ORDER BY created_at DESC`).all<Organization>();
	return res.results ?? [];
}

export async function getOrganizationById(env: Env, id: string): Promise<Organization | null> {
	if (!id) return null;
	const row = await env.DB.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(id).first<Organization>();
	return row ?? null;
}

export async function getOrganizationBySlug(env: Env, slug: string): Promise<Organization | null> {
	if (!slug) return null;
	const row = await env.DB.prepare(`SELECT * FROM organizations WHERE slug = ?`).bind(slug).first<Organization>();
	return row ?? null;
}

export async function updateOrganization(
	env: Env,
	id: string,
	input: { name?: unknown; slug?: unknown }
): Promise<{ ok: true; organization: Organization } | { ok: false; error: string }> {
	const existing = await getOrganizationById(env, id);
	if (!existing) return { ok: false, error: 'Organization not found' };
	const updates: string[] = [];
	const values: unknown[] = [];
	if (input.name !== undefined) {
		const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
		if (!name) return { ok: false, error: 'Name is required' };
		updates.push('name = ?');
		values.push(name);
	}
	if (input.slug !== undefined) {
		const slug = typeof input.slug === 'string' ? slugify(input.slug) : '';
		if (!slug) return { ok: false, error: 'Invalid slug' };
		if (slug !== existing.slug) {
			const conflict = await env.DB.prepare(`SELECT id FROM organizations WHERE slug = ? AND id != ?`).bind(slug, id).first();
			if (conflict) return { ok: false, error: 'Slug already exists' };
		}
		updates.push('slug = ?');
		values.push(slug);
	}
	if (updates.length === 0) return { ok: true, organization: existing };
	values.push(id);
	try {
		await env.DB.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
		const row = await getOrganizationById(env, id);
		return { ok: true, organization: row! };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function deleteOrganization(env: Env, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const existing = await getOrganizationById(env, id);
	if (!existing) return { ok: false, error: 'Organization not found' };
	const result = await env.DB.prepare(`DELETE FROM organizations WHERE id = ?`).bind(id).run();
	if ((result.meta.changes ?? 0) !== 1) return { ok: false, error: 'Delete failed' };
	return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

function isValidEmail(email: string): boolean {
	// simple check
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function createUser(
	env: Env,
	input: { email?: unknown; display_name?: unknown; displayName?: unknown; name?: unknown; password_hash?: unknown; passwordHash?: unknown }
): Promise<{ ok: true; user: User } | { ok: false; error: string }> {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid user data' };
	const emailRaw = typeof input.email === 'string' ? input.email.trim().toLowerCase().slice(0, 254) : '';
	if (!emailRaw) return { ok: false, error: 'Email is required' };
	if (!isValidEmail(emailRaw)) return { ok: false, error: 'Invalid email' };
	const display_name =
		typeof input.display_name === 'string'
			? input.display_name.trim().slice(0, 120) || null
			: typeof (input as Record<string, unknown>).displayName === 'string'
				? String((input as Record<string, unknown>).displayName).trim().slice(0, 120) || null
				: typeof input.name === 'string'
					? String(input.name).trim().slice(0, 120) || null
					: null;
	const password_hash =
		typeof input.password_hash === 'string'
			? input.password_hash.trim().slice(0, 1024) || null
			: typeof (input as Record<string, unknown>).passwordHash === 'string'
				? String((input as Record<string, unknown>).passwordHash).trim().slice(0, 1024) || null
				: null;
	const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(emailRaw).first();
	if (existing) return { ok: false, error: 'Email already exists' };
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	try {
		await env.DB.prepare(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, emailRaw, display_name, password_hash, now).run();
		const row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>();
		return { ok: true, user: row! };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes('UNIQUE') || msg.includes('unique')) return { ok: false, error: 'Email already exists' };
		return { ok: false, error: msg };
	}
}

export async function listUsers(env: Env): Promise<User[]> {
	const res = await env.DB.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all<User>();
	return res.results ?? [];
}

export async function getUserById(env: Env, id: string): Promise<User | null> {
	if (!id) return null;
	const row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>();
	return row ?? null;
}

export async function getUserByEmail(env: Env, email: string): Promise<User | null> {
	if (!email) return null;
	const row = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email.trim().toLowerCase()).first<User>();
	return row ?? null;
}

export async function deleteUser(env: Env, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const existing = await getUserById(env, id);
	if (!existing) return { ok: false, error: 'User not found' };
	const result = await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
	if ((result.meta.changes ?? 0) !== 1) return { ok: false, error: 'Delete failed' };
	return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Memberships
// ─────────────────────────────────────────────────────────────────────────────

export async function addMembership(
	env: Env,
	input: { organization_id?: unknown; organizationId?: unknown; org_id?: unknown; user_id?: unknown; userId?: unknown; role?: unknown }
): Promise<{ ok: true; membership: Membership } | { ok: false; error: string }> {
	const organization_id = String(input.organization_id ?? input.organizationId ?? input.org_id ?? '').trim();
	const user_id = String(input.user_id ?? input.userId ?? '').trim();
	const roleRaw = typeof input.role === 'string' ? input.role.trim().toLowerCase() : '';
	if (!organization_id) return { ok: false, error: 'organization_id is required' };
	if (!user_id) return { ok: false, error: 'user_id is required' };
	if (!roleRaw) return { ok: false, error: 'role is required' };
	if (!isValidRole(roleRaw)) return { ok: false, error: `Invalid role: must be one of ${VALID_ROLES.join(', ')}` };
	const org = await getOrganizationById(env, organization_id);
	if (!org) return { ok: false, error: 'Organization not found' };
	const user = await getUserById(env, user_id);
	if (!user) return { ok: false, error: 'User not found' };
	const existing = await env.DB.prepare(`SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?`).bind(organization_id, user_id).first<Membership>();
	if (existing) {
		// update role
		await env.DB.prepare(`UPDATE memberships SET role = ? WHERE organization_id = ? AND user_id = ?`).bind(roleRaw, organization_id, user_id).run();
		const updated = await env.DB.prepare(`SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?`).bind(organization_id, user_id).first<Membership>();
		return { ok: true, membership: updated! };
	}
	try {
		await env.DB.prepare(`INSERT INTO memberships (organization_id, user_id, role) VALUES (?, ?, ?)`).bind(organization_id, user_id, roleRaw).run();
		const row = await env.DB.prepare(`SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?`).bind(organization_id, user_id).first<Membership>();
		return { ok: true, membership: row! };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function listMemberships(env: Env, organizationId?: string): Promise<Membership[]> {
	if (organizationId) {
		const res = await env.DB.prepare(`SELECT * FROM memberships WHERE organization_id = ? ORDER BY rowid`).bind(organizationId).all<Membership>();
		return res.results ?? [];
	}
	const res = await env.DB.prepare(`SELECT * FROM memberships ORDER BY rowid`).all<Membership>();
	return res.results ?? [];
}

export async function getMembership(env: Env, organization_id: string, user_id: string): Promise<Membership | null> {
	if (!organization_id || !user_id) return null;
	const row = await env.DB.prepare(`SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?`).bind(organization_id, user_id).first<Membership>();
	return row ?? null;
}

export async function removeMembership(env: Env, organization_id: string, user_id: string): Promise<boolean> {
	if (!organization_id || !user_id) return false;
	const result = await env.DB.prepare(`DELETE FROM memberships WHERE organization_id = ? AND user_id = ?`).bind(organization_id, user_id).run();
	return (result.meta.changes ?? 0) === 1;
}

export async function hasRole(env: Env, organization_id: string, user_id: string, requiredRoles: Role | Role[]): Promise<boolean> {
	const membership = await getMembership(env, organization_id, user_id);
	if (!membership) return false;
	const needed = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
	return needed.includes(membership.role as Role);
}

export async function isOrganizationOwner(env: Env, organization_id: string, user_id: string): Promise<boolean> {
	return hasRole(env, organization_id, user_id, 'owner');
}

// ─────────────────────────────────────────────────────────────────────────────
// API Keys
// ─────────────────────────────────────────────────────────────────────────────

export async function createApiKey(
	env: Env,
	input: { name?: unknown; scopes?: unknown; scope?: unknown }
): Promise<{ ok: true; apiKey: ApiKeyRow; plainKey: string } | { ok: false; error: string }> {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid api key data' };
	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
	if (!name) return { ok: false, error: 'Name is required' };
	let scopesStr: string;
	if (Array.isArray(input.scopes)) {
		scopesStr = (input.scopes as unknown[]).map((s) => String(s).trim()).filter(Boolean).join(',');
	} else if (typeof input.scopes === 'string') {
		scopesStr = input.scopes.trim().slice(0, 1024);
	} else if (typeof input.scope === 'string') {
		scopesStr = String(input.scope).trim().slice(0, 1024);
	} else if (Array.isArray(input.scope)) {
		scopesStr = (input.scope as unknown[]).map((s) => String(s).trim()).filter(Boolean).join(',');
	} else {
		scopesStr = '';
	}
	if (!scopesStr) scopesStr = 'read';
	// basic scopes validation - allow any non-empty comma separated
	const plainKey = generatePlainKey();
	const key_hash = await sha256Hex(plainKey);
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	try {
		await env.DB.prepare(`INSERT INTO api_keys (id, name, key_hash, scopes, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, name, key_hash, scopesStr, null, now).run();
		const row = await env.DB.prepare(`SELECT * FROM api_keys WHERE id = ?`).bind(id).first<ApiKeyRow>();
		return { ok: true, apiKey: row!, plainKey };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function listApiKeys(env: Env): Promise<ApiKeyRow[]> {
	const res = await env.DB.prepare(`SELECT * FROM api_keys ORDER BY created_at DESC`).all<ApiKeyRow>();
	return res.results ?? [];
}

export async function getApiKeyById(env: Env, id: string): Promise<ApiKeyRow | null> {
	if (!id) return null;
	const row = await env.DB.prepare(`SELECT * FROM api_keys WHERE id = ?`).bind(id).first<ApiKeyRow>();
	return row ?? null;
}

export async function deleteApiKey(env: Env, id: string): Promise<boolean> {
	if (!id) return false;
	const result = await env.DB.prepare(`DELETE FROM api_keys WHERE id = ?`).bind(id).run();
	return (result.meta.changes ?? 0) === 1;
}

/**
 * Verify API key from Authorization: Bearer header.
 * Supports both verifyApiKey(env, request) and verifyApiKey(request, env) signatures.
 */
export async function verifyApiKey(
	arg1: Env | Request,
	arg2?: Env | Request
): Promise<{ ok: true; key: ApiKeyRow; actor: string } | { ok: false; error?: string }> {
	let env: Env | null = null;
	let request: Request | null = null;
	// Detect which arg is Env (has DB) and which is Request (has headers)
	const isEnv = (v: unknown): boolean => !!v && typeof v === 'object' && 'DB' in (v as Record<string, unknown>);
	if (isEnv(arg1) && arg2 instanceof Request) {
		env = arg1 as Env;
		request = arg2 as Request;
	} else if (arg1 instanceof Request && isEnv(arg2)) {
		request = arg1 as Request;
		env = arg2 as Env;
	} else if (isEnv(arg1) && arg2 && isEnv(arg2) === false && typeof (arg2 as Request).headers !== 'undefined') {
		env = arg1 as Env;
		request = arg2 as unknown as Request;
	} else if (arg1 instanceof Request && !arg2) {
		// No env provided — cannot verify without DB
		return { ok: false, error: 'Missing env' };
	} else {
		// Fallback: try to treat arg1 as Request, arg2 as Env
		if (arg1 instanceof Request) request = arg1 as Request;
		if (arg2 && isEnv(arg2)) env = arg2 as Env;
		if (!env || !request) return { ok: false, error: 'Invalid arguments' };
	}
	if (!env || !request) return { ok: false, error: 'Invalid arguments' };
	const authHeader = request.headers.get('Authorization') ?? request.headers.get('authorization') ?? '';
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match) return { ok: false, error: 'Missing Bearer token' };
	const plain = match[1].trim();
	if (!plain) return { ok: false, error: 'Empty token' };
	let hash: string;
	try {
		hash = await sha256Hex(plain);
	} catch {
		return { ok: false, error: 'Hash failed' };
	}
	const row = await env.DB.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).bind(hash).first<ApiKeyRow>();
	if (!row) return { ok: false, error: 'Invalid API key' };
	const now = Math.floor(Date.now() / 1000);
	// Update last_used_at best-effort
	try {
		await env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(now, row.id).run();
	} catch {
		// ignore
	}
	return { ok: true, key: row, actor: row.name };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit logs
// ─────────────────────────────────────────────────────────────────────────────

export async function logAudit(
	env: Env,
	paramsOrActor: string | { actor?: string | null; action: string; target_type?: string | null; target_id?: string | number | null; metadata?: string | Record<string, unknown> | null },
	maybeAction?: string,
	maybeTargetType?: string | null,
	maybeTargetId?: string | number | null,
	maybeMetadata?: string | Record<string, unknown> | null
): Promise<void> {
	let actor: string | null = null;
	let action: string | null = null;
	let target_type: string | null = null;
	let target_id: string | null = null;
	let metadata: string | null = null;

	if (typeof paramsOrActor === 'object' && paramsOrActor !== null && 'action' in paramsOrActor) {
		const p = paramsOrActor as { actor?: string | null; action: string; target_type?: string | null; target_id?: string | number | null; metadata?: string | Record<string, unknown> | null };
		actor = p.actor ?? null;
		action = p.action;
		target_type = p.target_type ?? null;
		target_id = p.target_id != null ? String(p.target_id) : null;
		if (p.metadata == null) metadata = null;
		else if (typeof p.metadata === 'string') metadata = p.metadata;
		else {
			try {
				metadata = JSON.stringify(p.metadata);
			} catch {
				metadata = String(p.metadata);
			}
		}
	} else if (typeof paramsOrActor === 'string') {
		actor = paramsOrActor || null;
		action = maybeAction ?? null;
		target_type = maybeTargetType ?? null;
		target_id = maybeTargetId != null ? String(maybeTargetId) : null;
		if (maybeMetadata == null) metadata = null;
		else if (typeof maybeMetadata === 'string') metadata = maybeMetadata;
		else {
			try {
				metadata = JSON.stringify(maybeMetadata);
			} catch {
				metadata = String(maybeMetadata);
			}
		}
	}
	if (!action) return;
	if (actor) actor = String(actor).slice(0, 256);
	if (target_type) target_type = String(target_type).slice(0, 64);
	if (target_id) target_id = String(target_id).slice(0, 128);
	if (metadata && metadata.length > 4096) metadata = metadata.slice(0, 4096);
	const now = Math.floor(Date.now() / 1000);
	try {
		await env.DB.prepare(`INSERT INTO audit_logs (actor, action, target_type, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(actor, action, target_type, target_id, metadata, now).run();
	} catch {
		// ignore logging failures
	}
}

export async function listAuditLogs(env: Env, opts?: { limit?: number; offset?: number }): Promise<AuditLog[]> {
	const limit = Math.min(Math.max(Number(opts?.limit ?? 100), 1), 500);
	const offset = Math.max(Number(opts?.offset ?? 0), 0);
	const res = await env.DB.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(limit, offset).all<AuditLog>();
	return res.results ?? [];
}

export async function getAuditLogById(env: Env, id: number): Promise<AuditLog | null> {
	const row = await env.DB.prepare(`SELECT * FROM audit_logs WHERE id = ?`).bind(id).first<AuditLog>();
	return row ?? null;
}
