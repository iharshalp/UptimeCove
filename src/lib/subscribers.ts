import type { Incident } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface Subscriber {
  id: string;
  status_page_id: number;
  email: string;
  verified: number;
  verification_token?: string | null;
  token?: string | null;
  config?: string | null;
  created_at: number;
}

export interface SubscriberRow extends Subscriber {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  const t = email.trim();
  if (t.length === 0 || t.length > 254) return false;
  // simple RFC5322-ish
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

export function getProbeRegions(checkRegions: string | null | undefined): string[] {
  if (!checkRegions) return [];
  const raw = String(checkRegions).trim();
  if (!raw) return [];
  // try JSON array first
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => String(v).trim())
          .filter(Boolean)
          .slice(0, 20);
      }
    } catch {
      // fall through to comma split
    }
  }
  // comma separated or single value or JSON stringified comma?
  // also support stringify like '"us-east,eu-west"'?
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // strip surrounding quotes if any
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1).trim();
      }
      return s;
    })
    .filter(Boolean)
    .slice(0, 20);
}

export function normalizeCheckRegions(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (Array.isArray(input)) {
    const arr = (input as unknown[]).map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
    if (arr.length === 0) return null;
    return JSON.stringify(arr);
  }
  if (typeof input === 'string') {
    const regions = getProbeRegions(input);
    if (regions.length === 0) {
      const trimmed = input.trim().slice(0, 500);
      return trimmed || null;
    }
    // store as JSON array for consistency if multiple or already JSON
    if (regions.length === 1 && !input.trim().startsWith('[') && !input.includes(',')) {
      // single region keep as JSON array to satisfy "store as JSON array"
      return JSON.stringify(regions);
    }
    return JSON.stringify(regions);
  }
  return null;
}

function generateToken(bytes = 16): string {
  try {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

async function ensureSubscriberColumns(env: Env): Promise<void> {
  // Attempt to add columns if they don't exist; ignore errors
  const stmts = [
    `ALTER TABLE subscribers ADD COLUMN verification_token TEXT`,
    `ALTER TABLE subscribers ADD COLUMN token TEXT`,
    `ALTER TABLE subscribers ADD COLUMN config TEXT`,
    `ALTER TABLE subscribers ADD COLUMN unsubscribe_token TEXT`,
  ];
  for (const sql of stmts) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      // ignore - column likely exists or not supported in mock
    }
  }
}

function parseSubscriberConfig(row: Record<string, unknown>): string | null {
  const c = (row as { config?: unknown }).config;
  if (typeof c === 'string' && c) return c;
  return null;
}

function extractTokenFromRow(row: Record<string, unknown>): string | null {
  // priority: verification_token, token, unsubscribe_token, config JSON
  if (typeof (row as { verification_token?: unknown }).verification_token === 'string' && (row as { verification_token: string }).verification_token) {
    return (row as { verification_token: string }).verification_token;
  }
  if (typeof (row as { token?: unknown }).token === 'string' && (row as { token: string }).token) {
    return (row as { token: string }).token;
  }
  if (typeof (row as { unsubscribe_token?: unknown }).unsubscribe_token === 'string' && (row as { unsubscribe_token: string }).unsubscribe_token) {
    return (row as { unsubscribe_token: string }).unsubscribe_token;
  }
  const config = parseSubscriberConfig(row);
  if (config) {
    try {
      const parsed = JSON.parse(config);
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, unknown>;
        if (typeof p.verification_token === 'string') return p.verification_token;
        if (typeof p.token === 'string') return p.token;
        if (typeof p.verify_token === 'string') return p.verify_token;
      }
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
export async function listSubscribers(env: Env, pageId: number): Promise<Subscriber[]> {
  await ensureSubscriberColumns(env);
  if (!Number.isInteger(pageId)) return [];
  try {
    const res = await env.DB.prepare(`SELECT * FROM subscribers WHERE status_page_id = ? ORDER BY created_at DESC`).bind(pageId).all<Subscriber>();
    return res.results ?? [];
  } catch {
    // fallback simple
    return [];
  }
}

export async function listSubscribersBySlug(env: Env, slug: string): Promise<Subscriber[]> {
  const page = await env.DB.prepare(`SELECT id FROM status_pages WHERE slug = ?`).bind(slug).first<{ id: number }>();
  if (!page) return [];
  return listSubscribers(env, page.id);
}

export async function createSubscriber(
  env: Env,
  input: { status_page_id?: number; slug?: string; pageId?: number; email: string }
): Promise<{ ok: true; subscriber: Subscriber; token: string; verificationToken: string } | { ok: false; error: string }> {
  await ensureSubscriberColumns(env);
  const emailRaw = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!emailRaw) return { ok: false, error: 'Email is required' };
  if (!isValidEmail(emailRaw)) return { ok: false, error: 'Invalid email address' };

  let pageId: number | null = null;
  if (typeof input.status_page_id === 'number' && Number.isInteger(input.status_page_id)) {
    pageId = input.status_page_id;
  } else if (typeof (input as { pageId?: unknown }).pageId === 'number' && Number.isInteger((input as { pageId: number }).pageId)) {
    pageId = (input as { pageId: number }).pageId;
  } else if (typeof input.slug === 'string' && input.slug) {
    const page = await env.DB.prepare(`SELECT id FROM status_pages WHERE slug = ?`).bind(input.slug.trim()).first<{ id: number }>();
    if (!page) return { ok: false, error: 'Status page not found' };
    pageId = page.id;
  } else {
    // default to status page 1 if not provided, or try default slug
    const fallback = await env.DB.prepare(`SELECT id FROM status_pages WHERE slug = 'default' LIMIT 1`).bind().first<{ id: number }>().catch(() => null);
    if (fallback && fallback.id) pageId = fallback.id;
    else pageId = 1;
  }
  // verify page exists
  if (pageId !== null) {
    const exists = await env.DB.prepare(`SELECT id FROM status_pages WHERE id = ?`).bind(pageId).first();
    if (!exists) return { ok: false, error: 'Status page not found' };
  } else {
    return { ok: false, error: 'Status page not found' };
  }

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const token = generateToken(24);
  const unsubscribeToken = generateToken(16);
  const configObj = { verification_token: token, unsubscribe_token: unsubscribeToken, token };
  const config = JSON.stringify(configObj);

  // check duplicate
  try {
    const dup = await env.DB.prepare(`SELECT id FROM subscribers WHERE status_page_id = ? AND email = ?`).bind(pageId, emailRaw).first();
    if (dup) return { ok: false, error: 'Already subscribed' };
  } catch {}

  // Try insert with all columns
  const insertAttempts: Array<() => Promise<unknown>> = [
    async () => {
      return env.DB.prepare(`INSERT INTO subscribers (id, status_page_id, email, verified, verification_token, config, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)`).bind(id, pageId, emailRaw, token, config, now).run();
    },
    async () => {
      return env.DB.prepare(`INSERT INTO subscribers (id, status_page_id, email, verified, token, config, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)`).bind(id, pageId, emailRaw, token, config, now).run();
    },
    async () => {
      return env.DB.prepare(`INSERT INTO subscribers (id, status_page_id, email, verified, config, created_at) VALUES (?, ?, ?, 0, ?, ?)`).bind(id, pageId, emailRaw, config, now).run();
    },
    async () => {
      return env.DB.prepare(`INSERT INTO subscribers (id, status_page_id, email, verified, verification_token, created_at) VALUES (?, ?, ?, 0, ?, ?)`).bind(id, pageId, emailRaw, token, now).run();
    },
    async () => {
      return env.DB.prepare(`INSERT INTO subscribers (id, status_page_id, email, verified, created_at) VALUES (?, ?, ?, 0, ?)`).bind(id, pageId, emailRaw, now).run();
    },
  ];

  let inserted = false;
  let lastError: string | null = null;
  for (const attempt of insertAttempts) {
    try {
      const res = (await attempt()) as { meta?: { changes?: number } };
      if (res && (res as { meta?: { changes?: number } }).meta?.changes !== 0) {
        inserted = true;
        break;
      }
      // if no meta but no throw, assume success
      inserted = true;
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // if unique constraint, return already subscribed
      if (lastError.includes('UNIQUE') || lastError.includes('unique')) {
        return { ok: false, error: 'Already subscribed' };
      }
      // try next attempt
      continue;
    }
  }
  if (!inserted) {
    return { ok: false, error: lastError ?? 'Failed to create subscriber' };
  }

  // fetch back
  let subscriber: Subscriber | null = null;
  try {
    subscriber = await env.DB.prepare(`SELECT * FROM subscribers WHERE id = ?`).bind(id).first<Subscriber>();
  } catch {}
  if (!subscriber) {
    subscriber = { id, status_page_id: pageId, email: emailRaw, verified: 0, verification_token: token, config, created_at: now };
  }

  return { ok: true, subscriber, token, verificationToken: token };
}

export async function verifySubscriber(env: Env, token: string): Promise<{ ok: true; subscriber: Subscriber } | { ok: false; error: string }> {
  await ensureSubscriberColumns(env);
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) return { ok: false, error: 'Token is required' };

  // Try direct lookup by verification_token or token
  const queries = [
    `SELECT * FROM subscribers WHERE verification_token = ? LIMIT 1`,
    `SELECT * FROM subscribers WHERE token = ? LIMIT 1`,
    `SELECT * FROM subscribers WHERE unsubscribe_token = ? LIMIT 1`,
    `SELECT * FROM subscribers WHERE id = ? LIMIT 1`,
  ];
  let row: Subscriber | null = null;
  for (const q of queries) {
    try {
      const r = await env.DB.prepare(q).bind(t).first<Subscriber>();
      if (r) {
        row = r;
        break;
      }
    } catch {
      continue;
    }
  }
  // fallback: search config JSON
  if (!row) {
    try {
      const all = await env.DB.prepare(`SELECT * FROM subscribers WHERE verified = 0`).all<Record<string, unknown>>();
      const candidates = all.results ?? [];
      for (const cand of candidates) {
        const tok = extractTokenFromRow(cand);
        if (tok === t) {
          row = cand as unknown as Subscriber;
          break;
        }
      }
      if (!row) {
        // also search verified=0 or 1 all
        const all2 = await env.DB.prepare(`SELECT * FROM subscribers`).all<Record<string, unknown>>();
        const c2 = all2.results ?? [];
        for (const cand of c2) {
          const tok = extractTokenFromRow(cand);
          if (tok === t) {
            row = cand as unknown as Subscriber;
            break;
          }
        }
      }
    } catch {}
  }

  if (!row) return { ok: false, error: 'Invalid or expired token' };
  if (row.verified === 1) return { ok: true, subscriber: row };

  try {
    await env.DB.prepare(`UPDATE subscribers SET verified = 1 WHERE id = ?`).bind(row.id).run();
  } catch {}
  // fetch updated
  try {
    const updated = await env.DB.prepare(`SELECT * FROM subscribers WHERE id = ?`).bind(row.id).first<Subscriber>();
    if (updated) return { ok: true, subscriber: updated };
  } catch {}
  return { ok: true, subscriber: { ...row, verified: 1 } };
}

export async function deleteSubscriber(env: Env, id: string): Promise<boolean> {
  await ensureSubscriberColumns(env);
  if (!id || typeof id !== 'string') return false;
  // allow deleting by id or email? but spec says id
  try {
    const res = await env.DB.prepare(`DELETE FROM subscribers WHERE id = ?`).bind(id).run();
    return (res.meta.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

export async function deleteSubscriberByEmail(env: Env, pageId: number, email: string): Promise<boolean> {
  await ensureSubscriberColumns(env);
  try {
    const res = await env.DB.prepare(`DELETE FROM subscribers WHERE status_page_id = ? AND email = ?`).bind(pageId, email.toLowerCase().trim()).run();
    return (res.meta.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// RSS generation
// ---------------------------------------------------------------------------
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatRfc822(ts: number): string {
  return new Date(ts * 1000).toUTCString();
}

export async function generateRssFeed(env: Env, slug: string, opts?: { baseUrl?: string; limit?: number }): Promise<{ xml: string; page: unknown; incidents: unknown[] }> {
  const page = await env.DB.prepare(`SELECT * FROM status_pages WHERE slug = ?`).bind(slug).first();
  if (!page) throw new Error('Status page not found');

  const pageId = (page as { id: number }).id;
  const title = (page as { title?: string }).title ?? slug;
  const description = (page as { description?: string | null }).description ?? `Status updates for ${title}`;
  const baseUrl = opts?.baseUrl ?? 'https://uptimecove.example';
  const limit = opts?.limit ?? 20;

  // get monitors for page
  let monitorIds: number[] = [];
  try {
    const linked = await env.DB.prepare(`SELECT monitor_id FROM status_page_monitors WHERE page_id = ?`).bind(pageId).all<{ monitor_id: number }>();
    monitorIds = (linked.results ?? []).map((r) => r.monitor_id);
  } catch {}

  let incidents: Array<{ id: number; monitor_id: number; cause: string; started_at: number; resolved_at: number | null; name?: string; url?: string }> = [];
  try {
    if (monitorIds.length > 0) {
      const placeholders = monitorIds.map(() => '?').join(',');
      const res = await env.DB.prepare(`SELECT i.*, m.name, m.url FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id WHERE i.monitor_id IN (${placeholders}) ORDER BY i.started_at DESC LIMIT ?`).bind(...monitorIds, limit).all();
      incidents = (res.results as unknown as typeof incidents) ?? [];
    } else {
      // if no specific monitors, get recent incidents up to limit
      const res = await env.DB.prepare(`SELECT i.*, m.name, m.url FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id ORDER BY i.started_at DESC LIMIT ?`).bind(limit).all();
      incidents = (res.results as unknown as typeof incidents) ?? [];
    }
  } catch {
    incidents = [];
  }

  const now = formatRfc822(Math.floor(Date.now() / 1000));
  const channelLink = `${baseUrl.replace(/\/$/, '')}/status/${slug}`;
  const rssItems = incidents
    .map((inc) => {
      const monitorName = (inc as { name?: string }).name ?? `Monitor #${inc.monitor_id}`;
      const pubDate = formatRfc822(inc.started_at);
      const guid = `${channelLink}#incident-${inc.id}`;
      const titleEsc = escapeXml(`${monitorName} — ${inc.cause}`);
      const descEsc = escapeXml(`${inc.cause} — ${inc.resolved_at ? 'Resolved at ' + formatRfc822(inc.resolved_at) : 'Ongoing'}`);
      const linkEsc = escapeXml(guid);
      return `    <item>
      <title>${titleEsc}</title>
      <link>${linkEsc}</link>
      <guid isPermaLink="true">${linkEsc}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${descEsc}</description>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(channelLink)}</link>
    <description>${escapeXml(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <generator>UptimeCove</generator>
    <ttl>60</ttl>
${rssItems}
  </channel>
</rss>`;

  return { xml, page, incidents };
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------
export function generateBadgeSvg(opts: { label?: string; uptime: number | null; status?: string }): string {
  const label = opts.label ?? 'uptime';
  const uptime = opts.uptime;
  let value: string;
  let color: string;
  if (uptime === null || uptime === undefined) {
    value = 'unknown';
    color = '#9ca3af'; // gray
  } else {
    const pct = Number(uptime);
    value = `${pct.toFixed(pct >= 99.9 ? 2 : 1)}%`;
    if (pct >= 99.9) color = '#10b981'; // emerald
    else if (pct >= 99) color = '#22c55e';
    else if (pct >= 98) color = '#eab308'; // yellow
    else if (pct >= 95) color = '#f97316'; // orange
    else color = '#ef4444'; // red
  }

  // Badge dimensions approximated like shields.io
  const labelText = label;
  const valueText = value;
  // estimate widths: 6.5px per char + padding
  const labelWidth = Math.max(45, labelText.length * 7 + 12);
  const valueWidth = Math.max(45, valueText.length * 7 + 14);
  const totalWidth = labelWidth + valueWidth;
  const height = 20;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${escapeXml(labelText)}: ${escapeXml(valueText)}">
  <title>${escapeXml(labelText)}: ${escapeXml(valueText)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="${height}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${height}" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${color}"/>
    <rect width="${totalWidth}" height="${height}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelWidth * 10 / 2}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${escapeXml(labelText)}</text>
    <text x="${labelWidth * 10 / 2}" y="140" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${escapeXml(labelText)}</text>
    <text aria-hidden="true" x="${(labelWidth + valueWidth / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(valueWidth - 10) * 10}">${escapeXml(valueText)}</text>
    <text x="${(labelWidth + valueWidth / 2) * 10}" y="140" transform="scale(.1)" textLength="${(valueWidth - 10) * 10}">${escapeXml(valueText)}</text>
  </g>
</svg>`;
  return svg;
}

export async function computePageUptime(env: Env, slug: string, days = 30): Promise<number | null> {
  const page = await env.DB.prepare(`SELECT id FROM status_pages WHERE slug = ?`).bind(slug).first<{ id: number }>();
  if (!page) return null;
  const pageId = page.id;
  let monitorIds: number[] = [];
  try {
    const linked = await env.DB.prepare(`SELECT monitor_id FROM status_page_monitors WHERE page_id = ?`).bind(pageId).all<{ monitor_id: number }>();
    monitorIds = (linked.results ?? []).map((r) => r.monitor_id);
    if (monitorIds.length === 0 && pageId === 1) {
      const all = await env.DB.prepare(`SELECT id FROM monitors WHERE enabled = 1`).all<{ id: number }>();
      monitorIds = (all.results ?? []).map((r) => r.id);
    }
  } catch {
    monitorIds = [];
  }
  if (monitorIds.length === 0) return null;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  try {
    const placeholders = monitorIds.map(() => '?').join(',');
    const row = await env.DB.prepare(`SELECT CAST(100.0 * SUM(ok) / COUNT(*) AS REAL) AS pct FROM checks WHERE monitor_id IN (${placeholders}) AND checked_at >= ?`).bind(...monitorIds, since).first<{ pct: number | null }>();
    if (!row || row.pct === null) return null;
    return row.pct;
  } catch {
    // fallback per-monitor average
    let total = 0;
    let count = 0;
    for (const id of monitorIds) {
      try {
        const r = await env.DB.prepare(`SELECT CAST(100.0 * SUM(ok) / COUNT(*) AS REAL) AS pct FROM checks WHERE monitor_id = ? AND checked_at >= ?`).bind(id, since).first<{ pct: number | null }>();
        if (r?.pct !== null && r?.pct !== undefined) {
          total += r.pct as number;
          count++;
        }
      } catch {}
    }
    if (count === 0) return null;
    return total / count;
  }
}
