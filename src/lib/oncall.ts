import type { OnCallSchedule, EscalationPolicy, IncidentPostmortem, Incident } from '../types';
import { summarizeIncident } from './ai';

export interface OnCallMember {
  name: string;
  email?: string;
  phone?: string;
}

export async function listSchedules(env: Env): Promise<OnCallSchedule[]> {
  const res = await env.DB.prepare(`SELECT * FROM on_call_schedules ORDER BY created_at DESC`).all<OnCallSchedule>();
  return res.results ?? [];
}

export async function getSchedule(env: Env, id: string): Promise<OnCallSchedule | null> {
  const row = await env.DB.prepare(`SELECT * FROM on_call_schedules WHERE id = ?`).bind(id).first<OnCallSchedule>();
  return row ?? null;
}

export async function createSchedule(env: Env, input: { name?: unknown; timezone?: unknown; rotation?: unknown; members?: unknown }): Promise<{ ok: true; schedule: OnCallSchedule } | { ok: false; error: string }> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid schedule data' };
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) return { ok: false, error: 'Name is required' };
  const timezone = typeof input.timezone === 'string' ? input.timezone.trim().slice(0, 64) : 'UTC';
  const rotationRaw = typeof input.rotation === 'string' ? input.rotation.trim().toLowerCase() : 'weekly';
  const allowedRot = new Set(['daily', 'weekly', 'monthly', 'custom']);
  const rotation = allowedRot.has(rotationRaw) ? rotationRaw : 'weekly';

  let membersStr: string;
  if (Array.isArray(input.members)) {
    membersStr = JSON.stringify((input.members as unknown[]).slice(0, 50));
  } else if (typeof input.members === 'string') {
    const s = input.members.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) return { ok: false, error: 'members must be array' };
        membersStr = JSON.stringify(parsed.slice(0, 50));
      } catch {
        return { ok: false, error: 'Invalid members JSON' };
      }
    } else if (s) {
      // comma-separated emails/names
      const arr = s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).map((email) => ({ name: email, email }));
      membersStr = JSON.stringify(arr);
    } else {
      return { ok: false, error: 'At least one member required' };
    }
  } else {
    return { ok: false, error: 'members is required (array or comma-separated string)' };
  }

  // Validate members not empty
  try {
    const arr = JSON.parse(membersStr);
    if (!Array.isArray(arr) || arr.length === 0) return { ok: false, error: 'At least one member required' };
  } catch {
    return { ok: false, error: 'Invalid members' };
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO on_call_schedules (id, name, timezone, rotation, members, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, name, timezone, rotation, membersStr, now).run();
  const row = await getSchedule(env, id);
  return { ok: true, schedule: row! };
}

export async function deleteSchedule(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM on_call_schedules WHERE id = ?`).bind(id).run();
  return (res.meta.changes ?? 0) === 1;
}

// Escalation policies
export async function listPolicies(env: Env): Promise<EscalationPolicy[]> {
  const res = await env.DB.prepare(`SELECT * FROM escalation_policies ORDER BY created_at DESC`).all<EscalationPolicy>();
  return res.results ?? [];
}

export async function getPolicy(env: Env, id: string): Promise<EscalationPolicy | null> {
  const row = await env.DB.prepare(`SELECT * FROM escalation_policies WHERE id = ?`).bind(id).first<EscalationPolicy>();
  return row ?? null;
}

export async function createPolicy(env: Env, input: { name?: unknown; schedule_id?: unknown; levels?: unknown }): Promise<{ ok: true; policy: EscalationPolicy } | { ok: false; error: string }> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid policy data' };
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) return { ok: false, error: 'Name is required' };
  const schedule_id = typeof input.schedule_id === 'string' ? input.schedule_id.trim() || null : (input.schedule_id as string | null) ?? null;
  if (schedule_id) {
    const sched = await getSchedule(env, schedule_id);
    if (!sched) return { ok: false, error: 'Schedule not found' };
  }
  let levelsStr: string;
  if (Array.isArray(input.levels)) {
    levelsStr = JSON.stringify((input.levels as unknown[]).slice(0, 20));
  } else if (typeof input.levels === 'string') {
    const s = input.levels.trim();
    if (!s) return { ok: false, error: 'levels required' };
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        const parsed = JSON.parse(s);
        levelsStr = JSON.stringify(parsed);
      } catch {
        return { ok: false, error: 'Invalid levels JSON' };
      }
    } else {
      // comma-separated durations?
      levelsStr = JSON.stringify(s.split(',').map((p) => p.trim()).filter(Boolean).map((d, idx) => ({ level: idx + 1, delay_minutes: Number(d) || 5, targets: [] })));
    }
  } else {
    // default single level
    levelsStr = JSON.stringify([{ level: 1, delay_minutes: 5, targets: [] }]);
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO escalation_policies (id, name, schedule_id, levels, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, name, schedule_id, levelsStr, now).run();
  const row = await getPolicy(env, id);
  return { ok: true, policy: row! };
}

export async function deletePolicy(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM escalation_policies WHERE id = ?`).bind(id).run();
  return (res.meta.changes ?? 0) === 1;
}

// Postmortems
export async function getPostmortem(env: Env, id: string): Promise<IncidentPostmortem | null> {
  const row = await env.DB.prepare(`SELECT * FROM incident_postmortems WHERE id = ?`).bind(id).first<IncidentPostmortem>();
  return row ?? null;
}

export async function getPostmortemByIncident(env: Env, incidentId: number): Promise<IncidentPostmortem | null> {
  const row = await env.DB.prepare(`SELECT * FROM incident_postmortems WHERE incident_id = ?`).bind(incidentId).first<IncidentPostmortem>();
  return row ?? null;
}

export async function listPostmortems(env: Env, limit = 20): Promise<Array<IncidentPostmortem & { incident_cause: string; monitor_name: string }>> {
  const res = await env.DB.prepare(
    `SELECT pm.*, i.cause as incident_cause, m.name as monitor_name
     FROM incident_postmortems pm
     JOIN incidents i ON i.id = pm.incident_id
     JOIN monitors m ON m.id = i.monitor_id
     ORDER BY pm.created_at DESC LIMIT ?`
  ).bind(limit).all<IncidentPostmortem & { incident_cause: string; monitor_name: string }>();
  return (res.results ?? []) as Array<IncidentPostmortem & { incident_cause: string; monitor_name: string }>;
}

export async function createPostmortem(
  env: Env,
  input: { incident_id?: unknown; title?: unknown; summary?: unknown; timeline?: unknown; action_items?: unknown; author?: unknown }
): Promise<{ ok: true; postmortem: IncidentPostmortem } | { ok: false; error: string }> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid data' };
  const incident_id = Number(input.incident_id);
  if (!Number.isInteger(incident_id)) return { ok: false, error: 'incident_id required' };
  const incident = await env.DB.prepare(`SELECT * FROM incidents WHERE id = ?`).bind(incident_id).first<Incident>();
  if (!incident) return { ok: false, error: 'Incident not found' };
  const existing = await getPostmortemByIncident(env, incident_id);
  if (existing) return { ok: false, error: 'Postmortem already exists for this incident' };

  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 300) : `Postmortem #${incident_id}`;
  if (!title) return { ok: false, error: 'Title required' };
  const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 10000) || null : null;
  const timeline = typeof input.timeline === 'string' ? input.timeline.trim().slice(0, 10000) || null : null;
  const action_items = typeof input.action_items === 'string' ? input.action_items.trim().slice(0, 10000) || null : null;
  const author = typeof input.author === 'string' ? input.author.trim().slice(0, 120) || null : null;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO incident_postmortems (id, incident_id, title, summary, timeline, action_items, author, ai_generated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(id, incident_id, title, summary, timeline, action_items, author, now, now).run();
  const row = await getPostmortem(env, id);
  return { ok: true, postmortem: row! };
}

export async function updatePostmortem(
  env: Env,
  id: string,
  input: { title?: unknown; summary?: unknown; timeline?: unknown; action_items?: unknown; author?: unknown }
): Promise<{ ok: true; postmortem: IncidentPostmortem } | { ok: false; error: string }> {
  const existing = await getPostmortem(env, id);
  if (!existing) return { ok: false, error: 'Postmortem not found' };
  const updates: string[] = [];
  const vals: unknown[] = [];
  if (input.title !== undefined) {
    const t = typeof input.title === 'string' ? input.title.trim().slice(0, 300) : '';
    if (!t) return { ok: false, error: 'Title required' };
    updates.push('title = ?'); vals.push(t);
  }
  if (input.summary !== undefined) { updates.push('summary = ?'); vals.push(typeof input.summary === 'string' ? input.summary.trim().slice(0, 10000) || null : null); }
  if (input.timeline !== undefined) { updates.push('timeline = ?'); vals.push(typeof input.timeline === 'string' ? input.timeline.trim().slice(0, 10000) || null : null); }
  if (input.action_items !== undefined) { updates.push('action_items = ?'); vals.push(typeof input.action_items === 'string' ? input.action_items.trim().slice(0, 10000) || null : null); }
  if (input.author !== undefined) { updates.push('author = ?'); vals.push(typeof input.author === 'string' ? input.author.trim().slice(0, 120) || null : null); }
  if (updates.length === 0) return { ok: true, postmortem: existing };
  updates.push('updated_at = ?'); vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  await env.DB.prepare(`UPDATE incident_postmortems SET ${updates.join(', ')} WHERE id = ?`).bind(...vals).run();
  const row = await getPostmortem(env, id);
  return { ok: true, postmortem: row! };
}

export async function deletePostmortem(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM incident_postmortems WHERE id = ?`).bind(id).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function generateAiPostmortem(
  env: Env,
  incidentId: number,
  author?: string | null
): Promise<{ ok: true; postmortem: IncidentPostmortem } | { ok: false; error: string }> {
  const incident = await env.DB.prepare(`SELECT * FROM incidents WHERE id = ?`).bind(incidentId).first<Incident & { monitor_id: number }>();
  if (!incident) return { ok: false, error: 'Incident not found' };
  const monitor = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`).bind(incident.monitor_id).first<import('../types').Monitor>();
  if (!monitor) return { ok: false, error: 'Monitor not found' };
  const recentChecks = await env.DB.prepare(`SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 10`).bind(incident.monitor_id).all<import('../types').Check>();
  const checks = (recentChecks.results ?? []) as import('../types').Check[];

  const ai = await summarizeIncident(env, incident as unknown as Incident, monitor as unknown as import('../types').Monitor, checks, 0);
  const durationMins = Math.max(1, Math.round(((incident.resolved_at ?? Math.floor(Date.now() / 1000)) - incident.started_at) / 60));
  const title = `Postmortem: ${(monitor as unknown as import('../types').Monitor).name} — ${new Date(incident.started_at * 1000).toLocaleDateString('en-US')} (${durationMins} min)`;
  const timeline = `- ${new Date(incident.started_at * 1000).toISOString()}: Incident started — ${incident.cause}\n- ${incident.resolved_at ? new Date(incident.resolved_at * 1000).toISOString() + ': Resolved' : 'Ongoing'}`;
  const actionItems = '- Verify root cause in service logs\n- Add alert threshold tuning if flaky\n- Document remediation steps';
  const existing = await getPostmortemByIncident(env, incidentId);
  if (existing) {
    return updatePostmortem(env, existing.id, { title, summary: ai.summary, timeline, action_items: actionItems, author: author ?? null }).then((r) => {
      if (!r.ok) return r as { ok: false; error: string };
      // mark ai_generated
      return env.DB.prepare(`UPDATE incident_postmortems SET ai_generated = 1 WHERE id = ?`).bind(existing.id).run().then(async () => {
        const row = await getPostmortem(env, existing.id);
        return { ok: true as const, postmortem: row! };
      });
    });
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO incident_postmortems (id, incident_id, title, summary, timeline, action_items, author, ai_generated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, incidentId, title, ai.summary, timeline, actionItems, author ?? null, ai.generatedBy === 'workers-ai' ? 1 : 0, now, now).run();
  const row = await getPostmortem(env, id);
  return { ok: true, postmortem: row! };
}
