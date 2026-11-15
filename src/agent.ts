// Client for the DayDeck planning agent. Talks to /api/agent (Claude on the
// server). If the server or the AI is unavailable, an on-device planner takes
// over so the experience still works end to end.

import type { SlotPart, Task } from './state.js';

export interface Proposal {
  taskId: string;
  part: SlotPart;
  reason: string;
}
export interface PlanResult {
  summary: string;
  proposals: Proposal[];
  source: 'ai' | 'offline';
}
export interface SuggestResult {
  tasks: Array<{ title: string; minutes: number }>;
  source: 'ai' | 'offline';
}

const API = (import.meta.env.VITE_AGENT_URL as string | undefined) ?? '/api/agent';

async function call<T>(body: unknown, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`agent ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function planDay(
  tasks: Task[],
  occupied: Record<SlotPart, number>,
): Promise<PlanResult> {
  const payload = tasks.map((t) => ({ id: t.id, title: t.title, minutes: t.minutes }));
  try {
    const r = await call<Omit<PlanResult, 'source'>>({
      action: 'plan',
      tasks: payload,
      occupied,
      localTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    const ids = new Set(tasks.map((t) => t.id));
    const proposals = (r.proposals || []).filter(
      (p) => ids.has(p.taskId) && ['morning', 'afternoon', 'evening'].includes(p.part),
    );
    if (proposals.length) return { summary: r.summary || '', proposals, source: 'ai' };
  } catch {
    /* fall through to offline planner */
  }
  return offlinePlan(tasks);
}

export interface ReviewResult extends PlanResult {
  recap: string;
}

/** End-of-day review: a short recap plus a proposed plan for carrying unfinished cards into tomorrow. */
export async function reviewDay(done: string[], unfinished: Task[], streak: number): Promise<ReviewResult> {
  const payload = unfinished.map((t) => ({ id: t.id, title: t.title, minutes: t.minutes }));
  try {
    const r = await call<{ recap: string; summary: string; proposals: Proposal[] }>({
      action: 'review',
      done,
      unfinished: payload,
      streak,
    });
    const ids = new Set(unfinished.map((t) => t.id));
    const proposals = (r.proposals || []).filter(
      (p) => ids.has(p.taskId) && ['morning', 'afternoon', 'evening'].includes(p.part),
    );
    if (r.recap) return { recap: r.recap, summary: r.summary || '', proposals, source: 'ai' };
  } catch {
    /* offline */
  }
  const plan = offlinePlan(unfinished);
  const n = done.length;
  const recap =
    n === 0
      ? 'A quiet day, and that is okay. Tomorrow is a fresh start.'
      : n === 1
        ? `You finished “${done[0]}”. One step forward counts.`
        : `You finished ${n} cards today, including “${done[0]}”. Nice work.`;
  return {
    recap,
    summary: unfinished.length ? 'Here is where I would carry your unfinished cards tomorrow.' : 'Nothing left over. Your rack is clear.',
    proposals: plan.proposals,
    source: 'offline',
  };
}

export async function suggestTasks(context: string): Promise<SuggestResult> {
  try {
    const r = await call<{ tasks: SuggestResult['tasks'] }>({ action: 'suggest', context });
    if (r.tasks?.length) return { tasks: r.tasks.slice(0, 4), source: 'ai' };
  } catch {
    /* offline */
  }
  return { tasks: OFFLINE_SUGGEST[context] ?? OFFLINE_SUGGEST['Deep work'], source: 'offline' };
}

// ---------------- offline planner ----------------

const RULES: Array<[RegExp, SlotPart, string]> = [
  [/write|proposal|design|code|study|deep|focus|plan\b|report/i, 'morning', 'Needs focus, so it goes in your peak-energy morning.'],
  [/walk|run|gym|exercise|yoga|stretch/i, 'morning', 'Movement early sets your energy for the day.'],
  [/email|reply|admin|call|meeting|errand|grocer|pay|book/i, 'afternoon', 'Lighter, reactive work fits the post-lunch dip.'],
  [/read|journal|tidy|reflect|tomorrow|wind|relax|mom|dad|friend/i, 'evening', 'Low-effort and personal, a good way to wind down.'],
];

function offlinePlan(tasks: Task[]): PlanResult {
  const proposals: Proposal[] = tasks.map((t) => {
    for (const [re, part, reason] of RULES) if (re.test(t.title)) return { taskId: t.id, part, reason };
    const part: SlotPart = t.minutes >= 60 ? 'morning' : 'afternoon';
    return {
      taskId: t.id,
      part,
      reason: part === 'morning' ? 'Long task, best tackled while you are fresh.' : 'Short task, slots in between bigger work.',
    };
  });
  return {
    summary: 'Offline planner: focus work in the morning, admin after lunch, personal time in the evening.',
    proposals,
    source: 'offline',
  };
}

const OFFLINE_SUGGEST: Record<string, Array<{ title: string; minutes: number }>> = {
  'Morning routine': [
    { title: 'Glass of water + stretch', minutes: 10 },
    { title: 'Review top 3 priorities', minutes: 10 },
    { title: '20-min focused sprint', minutes: 20 },
  ],
  'Deep work': [
    { title: 'Block 90 min, no notifications', minutes: 90 },
    { title: 'Outline the hardest problem', minutes: 30 },
    { title: 'Batch replies at 4 pm', minutes: 25 },
  ],
  'Wind-down': [
    { title: 'Plan tomorrow in 5 minutes', minutes: 5 },
    { title: 'Tidy desk', minutes: 10 },
    { title: 'Read for pleasure', minutes: 20 },
  ],
};
