/**
 * Pilot 决策 provider
 * - mock：本地确定性，用于 dry-run/selftest
 * - openai：OpenAI-compatible /chat/completions
 *
 * 输出统一动作 JSON：
 *   {"action":"observe"}
 *   {"action":"get_events"}
 *   {"action":"lua","code":"..."}
 *   {"action":"skill","skill":"..."}
 *   {"action":"say","text":"..."}
 *   {"action":"wait","ms":1000}
 *   {"action":"stop","reason":"..."}
 */

const SYSTEM = `You are the reference pilot for a Minecraft companion controlled through numen MCP.
Return exactly ONE JSON object, no markdown, no prose.
Allowed actions:
{"action":"observe"}                         // read status/events only
{"action":"get_events"}                      // read events only
{"action":"lua","code":"<lua>"}              // execute Lua; keep <=200 API calls
{"action":"skill","skill":"<skill id>"}      // call a numen skill
{"action":"say","text":"<short>"}            // speak
{"action":"wait","ms":1000}                  // wait
{"action":"stop","reason":"<short>"}         // end run
Rules:
- One action at a time.
- Prefer observe before acting.
- No omniscient/cheat scans; only numen/embodied APIs.
- Keep Lua short, return a compact result.
- If uncertain, observe or wait.
- When the test target is achieved, or you are stuck/looping, return {"action":"stop","reason":"..."} immediately.
- Do not continue for the sake of more actions; the harness also has hard time/step/token caps.`;

function extractJson(text) {
  const s = String(text ?? '').trim();
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* ignore */ }
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

export function createMockProvider() {
  return {
    kind: 'mock',
    async decide({ step }) {
      if (process.env.PILOT_MOCK_ACTION) {
        try { return JSON.parse(process.env.PILOT_MOCK_ACTION); } catch { /* fallthrough */ }
      }
      if (step === 0) return { action: 'observe' };
      if (step === 1) return { action: 'get_events' };
      return { action: 'stop', reason: 'mock-done' };
    },
  };
}

export function createOpenAIProvider({
  baseUrl = process.env.PILOT_LLM_BASE_URL,
  apiKey = process.env.PILOT_LLM_API_KEY,
  model = process.env.PILOT_LLM_MODEL,
  timeoutMs = 60_000,
} = {}) {
  if (!baseUrl || !model) {
    throw new Error(
      'openai provider requires PILOT_LLM_BASE_URL + PILOT_LLM_MODEL (and optional PILOT_LLM_API_KEY)',
    );
  }
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    kind: 'openai',
    async decide({ companion, step, observation, lastResult, history = [] }) {
      const messages = [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            companion,
            step,
            observation,
            lastResult,
            history: history.slice(-10),
          }),
        },
      ];
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content ?? '';
      const action = extractJson(content);
      if (!action || !action.action) {
        throw new Error(`LLM invalid action JSON: ${String(content).slice(0, 500)}`);
      }
      return { ...action, usage: data.usage || null };
    },
  };
}

export function createProvider(kind) {
  if (!kind || kind === 'mock') return createMockProvider();
  if (kind === 'openai') return createOpenAIProvider();
  throw new Error(`unknown provider: ${kind}`);
}
