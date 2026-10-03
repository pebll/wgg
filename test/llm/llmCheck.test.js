import { describe, it, expect } from 'vitest';
import { main } from '../../lib/cli/main.js';

const KEY = 'sk-never-print-me';
const env = { LLM_BASE_URL: 'https://gw.example/api', LLM_API_KEY: KEY };
const res = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

function run(args, llmFetch, extraEnv = {}) {
  const lines = [];
  return main(['llm-check', ...args], {
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    env: { ...env, ...extraEnv },
    llmFetch,
  }).then((code) => ({ code, text: lines.join('\n') }));
}

describe('#cli llm-check', () => {
  it('prints status, path and model ids only', async () => {
    const llmFetch = async (url) =>
      url.endsWith('/v1/models') ? res(200, { data: [{ id: 'big' }, { id: 'small' }] }) : res(404, {});
    const { code, text } = await run([], llmFetch);
    expect(code).toBe(0);
    expect(text).toContain('HTTP 200');
    expect(text).toContain('/v1/models');
    expect(text).toContain('big');
    expect(text).toContain('small');
    expect(text).not.toContain(KEY);
  });

  it('--chat sends one tiny completion and prints status and at most 80 characters', async () => {
    const llmFetch = async (url) =>
      url.endsWith('/models')
        ? res(200, { data: [{ id: 'm' }] })
        : res(200, { choices: [{ message: { content: 'x'.repeat(200) } }] });
    const { code, text } = await run(['--chat', '--model', 'm'], llmFetch);
    expect(code).toBe(0);
    expect(text).toMatch(/chat: HTTP 200/);
    expect(text).toContain('x'.repeat(80));
    expect(text).not.toContain('x'.repeat(81));
  });

  it('reports failures without the key and exits 1', async () => {
    const llmFetch = async () => res(401, { error: `bad ${KEY}` });
    const { code, text } = await run([], llmFetch);
    expect(code).toBe(1);
    expect(text).toContain('401');
    expect(text).not.toContain(KEY);
  });

  it('exits 1 naming the missing variable', async () => {
    const lines = [];
    const code = await main(['llm-check'], { out: (s) => lines.push(s), err: (s) => lines.push(s), env: {} });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('LLM_BASE_URL');
  });
});
