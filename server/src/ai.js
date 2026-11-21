// Optional AI auto-tagging (like Hoarder/Karakeep).
//   AI_PROVIDER=anthropic  -> Claude via the official SDK (needs ANTHROPIC_API_KEY)
//   AI_PROVIDER=ollama     -> fully local model via Ollama (OLLAMA_URL, AI_MODEL)
// Leave AI_PROVIDER unset to disable.
const PROVIDER = (process.env.AI_PROVIDER || '').toLowerCase();

const PROMPT = (b, existing) => `You tag bookmarks for a personal knowledge base.
Suggest 3 to 5 short, lowercase, reusable topic tags for the item below.
Prefer reusing these existing tags when they fit: ${existing.slice(0, 80).join(', ') || '(none yet)'}.
Reply with ONLY a JSON array of strings, e.g. ["javascript","performance"].

Title: ${b.title || ''}
URL: ${b.url || ''}
Description: ${b.description || ''}
Content: ${(b.content_text || b.note || '').slice(0, 4000)}`;

function parseTags(text) {
  const m = (text || '').match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]).filter(t => typeof t === 'string')
      .map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(t => t && t.length <= 40).slice(0, 5);
  } catch { return []; }
}

let anthropic;
async function claudeTags(prompt) {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new (Anthropic.default || Anthropic)();
  }
  const response = await anthropic.beta.messages.create({
    model: process.env.AI_MODEL || 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low' },
    // If the model declines, the API retries on a fallback model in the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') return [];
  return parseTags(response.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

async function ollamaTags(prompt) {
  const base = process.env.OLLAMA_URL || 'http://localhost:11434';
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'llama3.2',
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  return parseTags((await r.json()).message?.content);
}

const enabled = () => PROVIDER === 'anthropic' || PROVIDER === 'ollama';

async function suggestTags(bookmark, existingTags) {
  if (!enabled()) return [];
  const prompt = PROMPT(bookmark, existingTags);
  return PROVIDER === 'anthropic' ? claudeTags(prompt) : ollamaTags(prompt);
}

module.exports = { suggestTags, aiEnabled: enabled };
