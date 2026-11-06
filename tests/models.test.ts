import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { installGate, quotaOf } from '../src/gate.ts';
import { ledgerUsage } from '../src/commands.ts';

const tokens = { input_tokens: 1000, output_tokens: 100 };
const finish = { name: 'finish', args: { state: 'done', summary: 'done' } };
const look = { name: 'inspect', args: { list: ['.'] } };
const terraCall = quotaOf({ input: 1000, cached: 0, output: 100 });

// A model server that plays the given tool calls in order and keeps every request body.
async function modelServer(steps: { name: string; args: object }[]) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      requests.push(JSON.parse(body));
      const n = requests.length; const step = steps[n - 1] ?? finish;
      const item = { type: 'function_call', id: `i${n}`, call_id: `c${n}`, name: step.name,
        arguments: JSON.stringify(step.args), status: 'completed' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `r${n}`, status: 'completed', output: [item], usage: tokens } }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { requests, port: address.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

// Runs one task through the real CLI against the model server and removes what it made.
async function withRun(steps: { name: string; args: object }[], fields: object,
  check: (value: any, requests: any[], cli: (...args: string[]) => Promise<any>) => Promise<void> | void,
  extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-models-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  const model = await modelServer(steps);
  const env = { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '',
    ...extraEnv };
  const cli = (...args: string[]) => new Promise<any>(resolve => {
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', chunk => out += chunk);
    child.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()!)));
  });
  const file = path.join(root, 'task.json');
  writeFileSync(file, JSON.stringify({ id: 'models', goal: 'test', workspace: work, model: 'gpt-6.1-terra', effort: 'medium',
    box: 'none', max_quota_percent: 10, base_url: `http://127.0.0.1:${model.port}/v1`, ...fields }));
  let value: any;
  try {
    value = await cli('run', file);
    await check(value, model.requests, cli);
  } finally {
    await model.close();
    if (value?.run_dir) rmSync(value.run_dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test('a plain run sends no tier, whatever the environment says', async () => {
  await withRun([look, finish], {}, (value, requests) => {
    assert.equal(value.status, 'completed', JSON.stringify(value));
    assert.equal(value.service_tier, 'default');
    assert.ok(requests.length >= 2);
    for (const body of requests) assert.equal('service_tier' in body, false);
    const rows = readFileSync(path.join(value.run_dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.sha256);
    assert.deepEqual([...new Set(rows.map(row => row.service_tier))], ['default']);
  }, { CODEX_SERVICE_TIER: 'priority', SERVICE_TIER: 'priority', HARNESS_SERVICE_TIER: 'priority' });
});

test('the fast tier goes on every request, through a child and a resume', async () => {
  const steps = [{ name: 'delegate', args: { role: 'reader', task: 'finish' } }, finish, look, finish];
  await withRun(steps, { service_tier: 'priority', max_quota_percent: 0.0005,
    roles: { reader: { model: 'gpt-6-luna', effort: 'low', tools: ['finish'], max_quota_percent: 1 } } },
  async (value, requests, cli) => {
    assert.equal(value.service_tier, 'priority');
    assert.equal(value.status, 'budget_exhausted', JSON.stringify(value));
    const before = requests.length; assert.ok(before >= 2);
    assert.deepEqual([...new Set(requests.map(body => body.model))].sort(), ['gpt-6-luna', 'gpt-6.1-terra']);
    const resumed = await cli('resume', value.run_dir, '--max-quota-percent', '10');
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
    assert.equal(resumed.service_tier, 'priority');
    assert.ok(requests.length > before);
    for (const body of requests) assert.equal(body.service_tier, 'priority');
    const row = await cli('status', value.run_dir);
    assert.equal(row.service_tier, 'priority');
  });
});

test('the gate alone decides the tier a request carries', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-tier-'));
  const model = await modelServer([]);
  const send = async (serviceTier: 'priority' | undefined, sent: string | undefined) => {
    const restore = installGate({ allowedHosts: [`127.0.0.1:${model.port}`], ledgerPath: path.join(root, 'ledger.jsonl'),
      model: 'gpt-6.1-terra', effort: 'medium', tools: [], maxQuotaPercent: 10, serviceTier });
    try {
      const response = await fetch(`http://127.0.0.1:${model.port}/v1/responses`, { method: 'POST',
        body: JSON.stringify({ model: 'gpt-6.1-terra', reasoning: { effort: 'medium' }, tools: [],
          ...(sent ? { service_tier: sent } : {}) }) });
      await response.text(); await restore.flush();
    } finally { restore(); }
    return model.requests.at(-1).service_tier;
  };
  try {
    assert.equal(await send(undefined, 'priority'), undefined);
    assert.equal(await send(undefined, 'default'), undefined);
    assert.equal(await send('priority', undefined), 'priority');
    assert.equal(await send('priority', 'default'), 'priority');
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the quota counts each model by its weight, and a resume keeps the sum', async () => {
  const cases: [object, number][] = [[{ model: 'gpt-6.1-terra' }, 1], [{ model: 'gpt-6-luna' }, 0.1],
    [{ model: 'gpt-6.1-sol' }, 2], [{ model: 'gpt-6-sol' }, 2], [{ model: 'gpt-6-astra' }, 10],
    [{ model: 'gpt-6.1-terra', service_tier: 'priority' }, 2], [{ model: 'gpt-6-astra', service_tier: 'priority' }, 20]];
  for (const [fields, weight] of cases) {
    await withRun([finish], fields, (value, requests) => {
      assert.equal(value.status, 'completed', JSON.stringify(value));
      const expected = requests.length * terraCall * weight;
      assert.ok(Math.abs(value.usage.quota_percent - expected) < 1e-9, `${JSON.stringify(fields)} ${value.usage.quota_percent} ${expected}`);
      const again = ledgerUsage(path.join(value.run_dir, 'ledger.jsonl')).usage.quota_percent;
      assert.ok(Math.abs(again - expected) < 1e-9, `read back ${again} ${expected}`);
    });
  }
});

test('an incomplete response is counted, because its tokens were spent', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-incomplete-'));
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'response.incomplete', response: { usage: tokens } })}\n\ndata: [DONE]\n\n`);
  }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const usage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, quota_percent: 0 };
  const restore = installGate({ allowedHosts: [`127.0.0.1:${address.port}`], ledgerPath: path.join(root, 'ledger.jsonl'),
    model: 'gpt-6-astra', effort: 'medium', tools: [], maxQuotaPercent: 10, usage });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-astra', reasoning: { effort: 'medium' }, tools: [] }) });
    await response.text(); await restore.flush();
    assert.equal(usage.calls, 1);
    assert.ok(Math.abs(usage.quota_percent - terraCall * 10) < 1e-12, String(usage.quota_percent));
  } finally { restore(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test('a model without reasoning runs with no effort field', async () => {
  await withRun([finish], { model: 'gpt-4.1', effort: 'off' }, (value, requests) => {
    assert.equal(value.status, 'completed', JSON.stringify(value));
    assert.equal(requests[0].reasoning, undefined);
  });
});

test('a ledger from before the weights still adds up as terra', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-ledger-'));
  try {
    const file = path.join(root, 'ledger.jsonl');
    writeFileSync(file, JSON.stringify({ usage: { input: 1000, cached: 0, output: 100, reasoning: 0 } }) + '\n');
    assert.ok(Math.abs(ledgerUsage(file).usage.quota_percent - terraCall) < 1e-12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a budget stops an expensive model sooner', async () => {
  const limit = terraCall * 5;
  await withRun([look, finish], { model: 'gpt-6.1-terra', max_quota_percent: limit }, value => {
    assert.equal(value.status, 'completed', JSON.stringify(value));
  });
  await withRun([look, finish], { model: 'gpt-6-astra', max_quota_percent: limit }, value => {
    assert.equal(value.status, 'budget_exhausted', JSON.stringify(value));
  });
});

test('a new model name reaches the provider and counts as the dearest', async () => {
  await withRun([finish], { model: 'gpt-9-test', effort: 'high' }, (value, requests) => {
    assert.equal(value.status, 'completed', JSON.stringify(value));
    assert.equal(requests[0].model, 'gpt-9-test');
    assert.equal(requests[0].reasoning.effort, 'high');
    assert.ok(value.warnings.includes('model_not_in_catalog'));
    assert.ok(Math.abs(value.usage.quota_percent - requests.length * terraCall * 10) < 1e-9);
  });
  await withRun([finish], { model: 'not-a-model' }, (value, requests) => {
    assert.equal(value.reason, 'Unsupported model'); assert.equal(requests.length, 0);
  });
  await withRun([{ name: 'delegate', args: { role: 'r', task: 'finish' } }, finish, finish],
    { roles: { r: { model: 'gpt-9-child', effort: 'low', tools: ['finish'], max_quota_percent: 1 } } }, (value, requests) => {
      assert.equal(value.status, 'completed', JSON.stringify(value));
      assert.ok(requests.some(body => body.model === 'gpt-9-child'));
    });
});

test('an effort the model does not have is refused with the ones it has', async () => {
  for (const effort of ['ultra', 'minimal']) {
    await withRun([finish], { effort }, (value, requests) => {
      assert.equal(value.status, 'failed');
      assert.match(value.reason, new RegExp(`Unsupported effort for gpt-6\\.1-terra: ${effort}.*medium`));
      assert.equal(requests.length, 0);
    });
  }
  await withRun([finish], { model: 'gpt-6-astra', effort: 'off' }, value => {
    assert.match(value.reason, /Unsupported effort for gpt-6-astra: off/);
  });
  await withRun([finish], { roles: { r: { model: 'gpt-6-luna', effort: 'ultra', tools: ['finish'], max_quota_percent: 1 } } }, value => {
    assert.match(value.reason, /Unsupported effort for gpt-6-luna: ultra/);
  });
});

test('service_tier takes only the two known values', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-tier-value-')); const work = path.join(root, 'work'); mkdirSync(work);
  try {
    for (const service_tier of ['fast', 'flex', 1, null]) {
      const file = path.join(root, 'task.json');
      writeFileSync(file, JSON.stringify({ id: 'tier', goal: 'test', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', service_tier }));
      const child = spawnSync(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { encoding: 'utf8' });
      assert.equal(child.status, 1); assert.equal(JSON.parse(child.stdout).reason, 'Invalid service_tier');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
