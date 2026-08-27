export async function summarizeIncidents(env: Env, incidents: Array<{ cause: string; started_at: number; resolved_at: number | null }>): Promise<string> {
  try {
    const ai: any = (env as any).AI;
    if (ai && typeof ai.run === 'function') {
      const prompt = `Summarize these incidents in 2-3 sentences, include total count and average duration:\n${incidents.map(i=>`- ${i.cause} (${new Date(i.started_at*1000).toISOString()}${i.resolved_at?` → ${Math.round((i.resolved_at-i.started_at)/60)}m`:' ongoing'})`).join('\n')}`;
      const res: any = await ai.run('@cf/meta/llama-3-8b-instruct', { prompt });
      if (res?.response) return String(res.response).slice(0, 2000);
    }
  } catch {}
  if (incidents.length===0) return 'No incidents in the selected period.';
  const total = incidents.length;
  const ongoing = incidents.filter(i=>!i.resolved_at).length;
  const avg = Math.round(incidents.filter(i=>i.resolved_at).reduce((a,c)=>a+((c.resolved_at!-c.started_at)/60),0)/(incidents.filter(i=>i.resolved_at).length||1));
  return `AI summary (template): ${total} incident(s) recorded, ${ongoing} ongoing. Average resolved duration ~${avg||0}m. Top cause: "${incidents[0].cause}". Review maintenance windows and check thresholds.`;
}

export async function summarizeIncident(env: Env, incident: { cause: string; started_at: number; resolved_at: number | null }, monitor?: { name: string }, _checks?: unknown[], _extra?: number): Promise<{ summary: string; generatedBy: string }> {
  const text = await summarizeIncidents(env, [incident]);
  const isAi = text.includes('AI summary') ? 'template' : 'workers-ai';
  // include monitor context if available
  const prefix = monitor?.name ? `[${monitor.name}] ` : '';
  return { summary: prefix + text, generatedBy: isAi === 'workers-ai' ? 'workers-ai' : 'template' };
}
