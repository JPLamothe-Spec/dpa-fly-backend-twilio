import fetch from 'node-fetch';

// Hard constraint to stop “meta” narration + repetition
const SYSTEM = `
You are "Anna", a helpful voice assistant on a phone call.
Rules:
- Speak TO THE CALLER directly. Never narrate analysis like "it seems like the caller...".
- Be concise: 1 short sentence unless asked to elaborate.
- Confirm hearing once, then move on.
- If the user just says "hello", respond with a greeting and a question.
- If content repeats or is unclear, ask ONE short clarifying question.
- Never repeat the same sentence twice in a row. If your next sentence matches your last one, produce an alternative or say something new.
- No filler like "it seems", "appears", "might be".
- Keep latency low: prefer short sentences.
`;

export async function planReply({ transcript, lastBotText }) {
  // loop-guard client side too
  const guard = (s) => {
    if (!s) return s;
    const clean = s.trim();
    if (!clean) return '';
    if (lastBotText && clean.toLowerCase() === lastBotText.trim().toLowerCase()) {
      return ''; // drop identical repeats
    }
    return clean;
  };

  const user = `Caller: ${transcript}`;
  const body = {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
      lastBotText ? { role: 'assistant', content: `Previous reply (avoid repeating): ${lastBotText}` } : null
    ].filter(Boolean),
    temperature: 0.2,
    max_tokens: 60
  };

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const j = await r.json();
  const speak = guard(j.choices?.[0]?.message?.content || '');
  return { speak };
}
