// DayDeck server: serves the built WebXR app and the planning agent API.
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50kb' }));

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const PLAN_TOOL = {
  name: 'propose_plan',
  description: 'Propose where each task should go in the user\'s day. The user will accept or reject each placement with a hand gesture.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One short sentence describing the overall logic of the plan (max 18 words).' },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            part: { type: 'string', enum: ['morning', 'afternoon', 'evening'] },
            reason: { type: 'string', description: 'Why this time of day, max 10 words, friendly and specific.' },
          },
          required: ['taskId', 'part', 'reason'],
        },
      },
    },
    required: ['summary', 'proposals'],
  },
};

const REVIEW_TOOL = {
  name: 'review_day',
  description: 'Close out the user\'s day: a warm, specific recap, then a proposed placement for each unfinished card in tomorrow\'s plan. The user accepts or rejects each placement with a hand gesture.',
  input_schema: {
    type: 'object',
    properties: {
      recap: { type: 'string', description: 'Two short sentences max (30 words): acknowledge specific finished tasks and the streak; encouraging, never guilt-tripping.' },
      summary: { type: 'string', description: 'One short sentence on how tomorrow is arranged (max 16 words).' },
      proposals: PLAN_TOOL.input_schema.properties.proposals,
    },
    required: ['recap', 'summary', 'proposals'],
  },
};

const SUGGEST_TOOL = {
  name: 'deal_cards',
  description: 'Suggest small, concrete task cards for the given context.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Imperative, max 28 characters.' },
            minutes: { type: 'integer', minimum: 5, maximum: 120 },
          },
          required: ['title', 'minutes'],
        },
      },
    },
    required: ['tasks'],
  },
};

async function callTool(tool, system, user) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }],
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('no tool call');
  return block.input;
}

app.post('/api/agent', async (req, res) => {
  if (!client) return res.status(503).json({ error: 'AI not configured' });
  const { action } = req.body || {};
  try {
    if (action === 'plan') {
      const tasks = (req.body.tasks || []).slice(0, 12).map((t) => ({
        id: String(t.id).slice(0, 40),
        title: String(t.title).slice(0, 80),
        minutes: Number(t.minutes) || 15,
      }));
      const occupied = req.body.occupied || {};
      const out = await callTool(
        PLAN_TOOL,
        'You are DayDeck, a calm planning agent inside a VR productivity space. You place the user\'s task cards into Morning, Afternoon or Evening. Put focus-heavy work when energy is high (morning), reactive/admin work after lunch, and personal or low-effort tasks in the evening. Each part holds at most 4 cards; some slots may already be taken. Never invent tasks; use only the given ids.',
        `Local time: ${String(req.body.localTime || '').slice(0, 10)}\nSlots already used: ${JSON.stringify(occupied)}\nTasks:\n${JSON.stringify(tasks)}`,
      );
      return res.json(out);
    }
    if (action === 'review') {
      const done = (req.body.done || []).slice(0, 20).map((t) => String(t).slice(0, 80));
      const unfinished = (req.body.unfinished || []).slice(0, 12).map((t) => ({
        id: String(t.id).slice(0, 40),
        title: String(t.title).slice(0, 80),
        minutes: Number(t.minutes) || 15,
      }));
      const out = await callTool(
        REVIEW_TOOL,
        'You are DayDeck, a calm planning agent inside a VR productivity space. At the end of the day you review what the user finished and plan tomorrow for what is left. Be kind and specific. Never invent tasks; use only the given ids. Each part (morning, afternoon, evening) holds at most 4 cards.',
        `Finished today: ${JSON.stringify(done)}\nCurrent streak (days): ${Number(req.body.streak) || 0}\nUnfinished cards:\n${JSON.stringify(unfinished)}`,
      );
      return res.json(out);
    }
    if (action === 'suggest') {
      const context = String(req.body.context || '').slice(0, 40);
      const out = await callTool(
        SUGGEST_TOOL,
        'You are DayDeck, a planning agent in VR. Suggest exactly 3 short, concrete, doable task cards. No emojis.',
        `Context: ${context}`,
      );
      return res.json(out);
    }
    res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[agent]', err.message);
    res.status(502).json({ error: 'agent failed' });
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));
app.use(express.static(join(here, 'dist'), { maxAge: '1h' }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`DayDeck on http://localhost:${port} (AI: ${client ? MODEL : 'offline planner'})`));
