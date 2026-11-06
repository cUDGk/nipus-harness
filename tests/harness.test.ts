import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createTools } from '../src/tools.ts';
import { BudgetExhausted, GateBlocked, installGate } from '../src/gate.ts';
import { inspectDiff } from '../src/rules.ts';

process.env.HARNESS_QUOTA_COMMAND = '';

type ScriptStep = { tool?: string; args?: object; status?: number; disconnect?: boolean; input?: number; text?: string; delayCheck?: boolean };

async function scenario(steps: ScriptStep[], overrides: Record<string, unknown> = {}, preload = false, setup?: (work: string, root: string) => void) {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-scenario-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(work); mkdirSync(agent);
  writeFileSync(path.join(work, 'long.txt'), ('0123456789'.repeat(10) + '\n').repeat(250));
  setup?.(work, root);
  const requests: Array<Record<string, any>> = [];
  const times: number[] = [];
  const server = http.createServer((req, res) => {
    let data = ''; req.setEncoding('utf8'); req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(data)); times.push(Date.now());
      const step = steps[requests.length - 1] ?? { text: 'done' };
      if (step.disconnect) { req.socket.destroy(); return; }
      if (step.status) { res.writeHead(step.status); res.end('temporary error'); return; }
      const id = requests.length;
      const item = step.tool ? { type: 'function_call', id: `item_${id}`, call_id: `call_${id}`, name: step.tool, arguments: JSON.stringify(step.args ?? {}), status: 'completed' } : { type: 'message', id: `item_${id}`, role: 'assistant', content: [{ type: 'output_text', text: step.text ?? 'done', annotations: [] }], status: 'completed' };
      const response = { id: `response_${id}`, status: 'completed', output: [item], usage: { input_tokens: step.input ?? 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: (step.input ?? 30) + 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const taskFile = path.join(root, 'task.json');
  const terms = path.join(root, 'terms'); writeFileSync(terms, 'secret-name\n');
  const task: Record<string, unknown> = { id: 'scenario', goal: 'ordinary task', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', read_roots: [], forbidden_terms_file: null, max_quota_percent: 10, base_url: `http://127.0.0.1:${address.port}/v1`, ...overrides };
  if (task.forbidden_terms_file === 'terms') task.forbidden_terms_file = terms;
  writeFileSync(taskFile, JSON.stringify(task));
  let runDir: string | undefined;
  try {
    const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(path.resolve('tests/ledger-failure.mjs')).href] : []), path.resolve('src/cli.ts'), 'run', taskFile], { cwd: root, env: { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake-test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(stdout.trim().split('\n').length, 1);
    const value = JSON.parse(stdout); runDir = value.run_dir;
    assert.equal(code, value.status === 'completed' ? 0 : 1, stderr);
    let ledger: Array<Record<string, any>> = [];
    if (runDir) { try { ledger = readFileSync(path.join(runDir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { /* No ledger on startup failure. */ } }
    return { value, requests, ledger, times, root, terms, stderr, markerExists: existsSync(path.join(root, 'marker')) };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

const finishStep = { tool: 'finish', args: { state: 'done', summary: 'done' } };
const repository = (work: string) => {
  execFileSync('git', ['init', '-q', work]);
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
};

test('account quota blocks at 99, caches readings, and fails open', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/quota-'));
  const original = globalThis.fetch; const clock = Date.now; let now = 100000; let received = 0;
  globalThis.fetch = async () => { received++; return new Response('ok'); };
  Date.now = () => now;
  try {
    for (const [output, expected] of [['99', 0], ['98', 2], ['error', 2]] as const) {
      const ledger = path.join(root, `ledger-${output}`); const count = path.join(root, `count-${output}`);
      writeFileSync(ledger, '');
      const code = `require('fs').appendFileSync(${JSON.stringify(count)},'x');${output === 'error' ? 'process.exit(1)' : `console.log(JSON.stringify({rateLimits:{primary:{usedPercent:${output}}}}))`}`;
      const warnings: string[] = [];
      const restore = installGate({ allowedHosts: ['localhost:1234'], model: 'model', effort: 'medium', tools: [],
        ledgerPath: ledger, maxQuotaPercent: 1, quotaCommand: JSON.stringify([process.execPath, '-e', code]),
        onQuotaFailure: () => warnings.push('quota_read_failed') });
      const send = () => fetch('http://localhost:1234/responses', { method: 'POST',
        body: JSON.stringify({ model: 'model', reasoning: { effort: 'medium' } }) });
      const before = received;
      try {
        if (output === '99') {
          await assert.rejects(send(), (e: unknown) => e instanceof BudgetExhausted && e.message === 'account_limit');
          await assert.rejects(send(), BudgetExhausted);
        } else { await send(); await send(); await restore.flush(); }
        assert.equal(received - before, expected); assert.equal(readFileSync(count, 'utf8'), 'x');
        now += 60000;
        if (output === '99') await assert.rejects(send(), BudgetExhausted); else await send();
        await restore.flush(); assert.equal(readFileSync(count, 'utf8'), 'xx');
        assert.equal(warnings.length, output === 'error' ? 2 : 0);
        assert.equal(readFileSync(ledger, 'utf8').includes('quota_read_failed'), output === 'error');
      } finally { restore(); }
    }
  } finally { Date.now = clock; globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('resume restores conversation and cumulative usage after budget exhaustion', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-resume-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(work); mkdirSync(agent); writeFileSync(path.join(work, 'sample'), 'resume-canary');
  const requests: any[] = [];
  let hold = false; let waiting: (() => void) | undefined; let heldResponse: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk; }); req.on('end', () => {
      requests.push(JSON.parse(data));
      const id = requests.length;
      if (hold && id === 4) { heldResponse = res; waiting?.(); return; }
      const inspect = id === 1 || (hold && id === 3);
      const name = inspect ? 'inspect' : 'finish';
      const args = inspect ? { reads: [{ path: 'sample' }] } : { state: 'done', summary: 'done' };
      const item = { type: 'function_call', id: `i${id}`, call_id: `c${id}`, name, arguments: JSON.stringify(args), status: 'completed' };
      const response = { id: `r${id}`, status: 'completed', output: [item], usage: { input_tokens: 30,
        input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const task = path.join(root, 'task.json');
  writeFileSync(task, JSON.stringify({ id: 'resume', goal: 'read sample', workspace: work, model: 'gpt-6.1-terra',
    effort: 'medium', max_quota_percent: 0.000001, base_url: `http://127.0.0.1:${address.port}/v1` }));
  let runDir = ''; let killedDir = '';
  const cli = async (args: string[]) => {
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), ...args], { env: { ...process.env,
      HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake-test-key', HARNESS_QUOTA_COMMAND: '' } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const code = await new Promise(resolve => child.on('close', resolve));
    const result = JSON.parse(stdout); assert.equal(code, result.status === 'completed' ? 0 : 1, stderr);
    return result;
  };
  try {
    const first = await cli(['run', task]); runDir = first.run_dir;
    assert.equal(first.status, 'budget_exhausted'); assert.equal(requests.length, 1);
    const second = await cli(['resume', runDir, '--max-quota-percent', '1']);
    assert.equal(second.status, 'completed', JSON.stringify(second)); assert.equal(second.usage.calls, 2);
    assert.equal(second.usage.input, 40); assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /resume-canary/);
    const refused = await cli(['resume', runDir]);
    assert.equal(refused.status, 'failed'); assert.match(refused.reason, /completed/); assert.equal(requests.length, 2);
    const killedId = `killed-${Date.now()}`; const killedTask = path.join(root, 'killed.json');
    writeFileSync(killedTask, JSON.stringify({ id: killedId, goal: 'read sample', workspace: work,
      model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 1,
      base_url: `http://127.0.0.1:${address.port}/v1` }));
    hold = true;
    const blocked = new Promise<void>(resolve => { waiting = resolve; });
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', killedTask], { env: { ...process.env,
      HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake-test-key', HARNESS_QUOTA_COMMAND: '' } });
    await blocked;
    const runRoot = path.resolve('runs');
    killedDir = path.join(runRoot, readdirSync(runRoot).find(name => name.startsWith(killedId + '-'))!);
    assert.equal(existsSync(path.join(killedDir, 'result.json')), false);
    const closed = new Promise(resolve => child.on('close', resolve)); child.kill(); await closed;
    heldResponse?.destroy(); hold = false;
    const resumed = await cli(['resume', killedDir]);
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed)); assert.equal(resumed.usage.calls, 2);
    assert.match(JSON.stringify(requests[4]), /resume-canary/);
    // The caller may judge a block invalid and continue the run.
    const resultFile = path.join(killedDir, 'result.json');
    writeFileSync(resultFile, JSON.stringify({ ...JSON.parse(readFileSync(resultFile, 'utf8')), status: 'blocked' }));
    const note = path.join(root, 'note.txt'); writeFileSync(note, 'caller-answer-canary\n');
    const unblocked = await cli(['resume', killedDir, '--message-file', note]);
    assert.equal(unblocked.status, 'completed', JSON.stringify(unblocked));
    assert.match(JSON.stringify(requests.at(-1)), /caller-answer-canary/);
    writeFileSync(resultFile, JSON.stringify({ ...JSON.parse(readFileSync(resultFile, 'utf8')), status: 'blocked' }));
    const badOption = await cli(['resume', killedDir, '--message-file']);
    assert.equal(badOption.status, 'failed'); assert.match(badOption.reason, /Invalid resume arguments/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    if (killedDir) rmSync(killedDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing task returns failed JSON and exit code 1', () => {
  const child = spawnSync(process.execPath, [path.resolve('src/cli.ts'), 'run',
    path.join(os.tmpdir(), `missing-task-${process.pid}.json`)], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.equal(JSON.parse(child.stdout).status, 'failed');
});

test('G1 G2 G3 CLI failures and controls', async () => {
  const blocked = await scenario([finishStep], { goal: 'SECRET-NAME', forbidden_terms_file: 'terms' });
  assert.equal(blocked.requests.length, 0); assert.equal(blocked.value.status, 'quarantined'); assert.equal(blocked.value.reason, 'forbidden_term');
  const control = await scenario([finishStep], { forbidden_terms_file: 'terms' }); assert.equal(control.requests.length, 1); assert.equal(control.value.status, 'completed');
  const broken = await scenario([finishStep], {}, true); assert.equal(broken.requests.length, 0); assert.equal(broken.value.status, 'failed'); assert.match(broken.value.reason, /ledger unavailable/);
  const missing = await scenario([finishStep], { forbidden_terms_file: path.resolve('.test-tmp/does-not-exist') }); assert.equal(missing.requests.length, 0); assert.equal(missing.value.status, 'failed');
});

test('invalid task fields fail before a model request', async () => {
  for (const overrides of [{ model: undefined }, { effort: undefined }, { unexpected: true },
    { acceptance: [{ id: 'check', command: 'echo ok', timeout_s: '30' }] }]) {
    const value = await scenario([finishStep], overrides);
    assert.equal(value.value.status, 'failed'); assert.ok(value.value.reason); assert.equal(value.requests.length, 0);
  }
  // Each of these would start a run if the nested field went unchecked, so the reason names the check that caught it.
  for (const [overrides, reason] of [[{ scope: { proteted: [] } }, 'Invalid scope'],
    [{ scope: { allow: 'x' } }, 'Invalid scope'],
    [{ roles: { worker: { model: 'gpt-6.1-terra', effort: 'low', tools: ['finish'], max_quota_percent: 1,
      extra: true } } }, 'Invalid role'],
    [{ questions: [{ id: 'a', text: 'x', extra: 1 }] }, 'Invalid questions'],
    [{ questions: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }, 'Invalid questions'],
    [{ max_continues: -1 }, 'Invalid max_continues'], [{ max_continues: '3' }, 'Invalid max_continues'],
    [{ read_roots: ['relative'] }, 'Invalid read_roots']] as const) {
    const value = await scenario([finishStep], overrides);
    assert.equal(value.value.status, 'failed'); assert.equal(value.value.reason, reason, JSON.stringify(overrides));
    assert.equal(value.requests.length, 0);
  }
  const control = await scenario([finishStep]);
  assert.equal(control.value.status, 'completed'); assert.equal(control.requests.length, 1);
});

test('G6 budget stops the next CLI request', async () => {
  const value = await scenario([{ tool: 'inspect', args: { list: ['.'] } }, finishStep], { max_quota_percent: 0.000001 });
  assert.equal(value.requests.length, 1); assert.equal(value.value.status, 'budget_exhausted'); assert.equal(value.value.reason, 'budget_exhausted');
  assert.equal(value.value.usage.calls, 1);
});

test('CLI completes in a clean git worktree', async () => {
  const value = await scenario([finishStep], {}, false, (work, root) => {
    rmSync(work, { recursive: true, force: true });
    const repo = path.join(root, 'repo'); mkdirSync(repo); writeFileSync(path.join(repo, 'file'), 'original');
    repository(repo); execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'worktree-test', work]);
  });
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
  assert.equal(value.requests.length, 1);
});

test('G7 retry and transport failure keep ledger and successful status', async () => {
  for (const first of [{ status: 500 }, { disconnect: true }]) {
    const value = await scenario([first, finishStep]);
    assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
    assert.equal(value.requests.length, 2); assert.equal(value.ledger.filter(row => row.sha256).length, 2);
  }
});

test('effort mapping follows the actual request', async () => {
  for (const effort of ['off', 'low', 'medium', 'high']) {
    const value = await scenario([finishStep], { effort });
    assert.equal(value.value.status, 'completed', effort + ' ' + JSON.stringify(value.value));
    assert.equal(value.requests[0].reasoning?.effort, effort === 'off' ? 'none' : effort);
  }
});

test('G9 run blocks model requests until it exits', async () => {
  const value = await scenario([{ tool: 'run', args: { command: 'Start-Sleep -Seconds 3', timeout_s: 10 } }, finishStep]);
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
  assert.equal(value.requests.length, 2); assert.ok(value.times[1] - value.times[0] >= 3000);
});

test('C1 a plain reply causes a continuation', async () => {
  const value = await scenario([{ text: 'I completed the work.' }, finishStep]);
  assert.equal(value.requests.length, 2); assert.equal(value.value.status, 'completed');
  assert.equal(value.value.continues, 1); assert.match(JSON.stringify(value.requests[1]), /finish/);
});

test('C2 failed acceptance overrides a claimed pass and reports the log', async () => {
  const value = await scenario([{ tool: 'finish', args: { state: 'done', summary: 'all tests passed' } }, { tool: 'run', args: { command: "Set-Content marker ok", timeout_s: 10 } }, finishStep], { acceptance: [{ id: 'a1', command: 'if (Test-Path marker) { exit 0 }; Write-Output last_failure; exit 7', timeout_s: 10 }] });
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
  assert.equal(value.value.continues, 1); assert.equal(value.value.checks[0].exit_code, 0);
  assert.match(JSON.stringify(value.requests[1]), /last_failure/); assert.match(JSON.stringify(value.requests[1]), /a1/);
});

test('C3 blocked is challenged once and C4 continuation limit', async () => {
  const blockedStep = { tool: 'finish', args: { state: 'blocked', summary: 'cannot proceed' } };
  const blocked = await scenario([blockedStep, blockedStep]);
  assert.equal(blocked.value.status, 'blocked'); assert.equal(blocked.value.reason, 'cannot proceed'); assert.equal(blocked.requests.length, 2);
  assert.match(JSON.stringify(blocked.requests[1]), /only for something your tools cannot resolve/);
  const worked = await scenario([blockedStep, { tool: 'run', args: { command: 'Write-Output x', timeout_s: 10 } }, blockedStep, blockedStep]);
  assert.equal(worked.value.status, 'blocked', JSON.stringify(worked.value)); assert.equal(worked.value.continues, 2); assert.equal(worked.requests.length, 4);
  const finished = await scenario([blockedStep, { tool: 'run', args: { command: 'Set-Content marker ok', timeout_s: 10 } }, finishStep], { acceptance: [{ id: 'a1', command: 'if (Test-Path marker) { exit 0 }; exit 7', timeout_s: 10 }] });
  assert.equal(finished.value.status, 'completed', JSON.stringify(finished.value)); assert.equal(finished.value.continues, 1);
  const limited = await scenario([{ text: 'one' }, { text: 'two' }], { max_continues: 1 });
  assert.equal(limited.value.status, 'needs_judgment'); assert.equal(limited.value.continues, 1);
});

test('C5 idle continuations stop, but tool calls keep retrying', async () => {
  const idle = await scenario([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  assert.equal(idle.value.status, 'needs_judgment'); assert.equal(idle.value.continues, 2);
  const failing = { acceptance: [{ id: 'a1', command: 'exit 7', timeout_s: 10 }] };
  const work = { tool: 'run', args: { command: 'Write-Output x', timeout_s: 10 } };
  const active = await scenario([work, finishStep, work, finishStep, work, finishStep, work, finishStep], { max_continues: 3, ...failing });
  assert.equal(active.value.status, 'needs_judgment'); assert.equal(active.value.continues, 3); assert.equal(active.requests.length, 8);
  // Claiming done again without any work is idle too.
  const claims = await scenario([finishStep, finishStep, finishStep, finishStep], { max_continues: 5, ...failing });
  assert.equal(claims.value.status, 'needs_judgment'); assert.equal(claims.value.continues, 2); assert.equal(claims.requests.length, 3);
});

test('C6 questions require evidence and a conclusion', async () => {
  const answer = (evidence: string[]) => ({ tool: 'finish', args: { state: 'done', summary: 'done', answers: [{ id: 'q1', conclusion: 'yes', status: 'confirmed', evidence }] } });
  const value = await scenario([finishStep, answer([]), answer(['source'])], { questions: [{ id: 'q1', text: 'what?' }] });
  assert.equal(value.value.status, 'completed'); assert.equal(value.value.continues, 2);
  assert.match(JSON.stringify(value.requests[1]), /q1/); assert.match(JSON.stringify(value.requests[2]), /q1/);
});

test('C7 each spec section needs a path:line per item', async () => {
  const spec = '# Spec\n- intro is not a section\n## 1. Colors\n- dark\n  - no gradients\n## 2. Layout\nText only.\n';
  const answers = (colors: string[], layout: string[]) => ({ tool: 'finish', args: { state: 'done', summary: 'done', answers: [
    { id: 'spec.md 1. Colors', conclusion: 'yes', status: 'confirmed', evidence: colors },
    { id: 'spec.md 2. Layout', conclusion: 'yes', status: 'confirmed', evidence: layout }] } });
  const work = { tool: 'inspect', args: { list: ['.'] } };
  const value = await scenario([finishStep, answers(['long.txt:1 dark'], ['missing.txt:1']), work,
    answers(['long.txt:1', '`long.txt:250` no gradients'], ['long.txt:9999']), work, answers(['long.txt:1', 'long.txt:2'], ['spec.md:7'])],
    { specs: ['spec.md'] }, false, dir => writeFileSync(path.join(dir, 'spec.md'), spec));
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value)); assert.equal(value.value.continues, 3);
  assert.match(JSON.stringify(value.requests[0]), /spec.md 1. Colors/); assert.match(JSON.stringify(value.requests[0]), /spec.md 2. Layout/);
  // Each request carries the whole history; the harness's latest message is the last user item.
  const latest = (n: number) => JSON.stringify(value.requests[n].input.filter((item: { role?: string }) => item.role === 'user').at(-1));
  assert.match(latest(1), /spec.md 1. Colors: answer or evidence missing/);
  assert.match(latest(2), /1. Colors: needs 2 path:line .* found 1/); assert.match(latest(2), /2. Layout: needs 1 path:line .* found 0/);
  assert.doesNotMatch(latest(4), /1. Colors: needs/); assert.match(latest(4), /2. Layout: needs 1 path:line .* found 0/);
  const outside = await scenario([], { specs: ['../spec.md'] });
  assert.equal(outside.value.status, 'failed'); assert.equal(outside.value.reason, 'Invalid specs');
});

test('D1 D2 D5 child uses declared profile and cannot delegate', async () => {
  const roles = { reader: { model: 'gpt-6-luna', effort: 'low', tools: ['inspect', 'finish'], max_quota_percent: 1 } };
  const value = await scenario([
    { tool: 'delegate', args: { role: 'missing', task: 'x' } },
    { tool: 'delegate', args: { role: 'reader', task: 'read' } },
    { tool: 'finish', args: { state: 'done', summary: 'child result' } }, finishStep,
  ], { roles });
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
  assert.match(JSON.stringify(value.requests[1]), /unknown_role/);
  assert.equal(value.requests[2].model, 'gpt-6-luna'); assert.equal(value.requests[2].reasoning.effort, 'low');
  assert.doesNotMatch(JSON.stringify(value.requests[2].tools ?? value.requests[2].input.filter((i: any) => i.type === 'additional_tools')), /delegate/);
  assert.match(JSON.stringify(value.requests[3]), /child result/);
  assert.equal(value.value.usage.by_role.reader.calls, 1); assert.equal(value.value.usage.by_role.reader.input, 20);
});

test('D4 child budget stops the child while the parent continues', async () => {
  const roles = { reader: { model: 'gpt-6-luna', effort: 'low', tools: ['inspect', 'finish'], max_quota_percent: 0 } };
  const value = await scenario([{ tool: 'delegate', args: { role: 'reader', task: 'read' } }, { tool: 'inspect', args: { list: ['.'] } }, finishStep], { roles });
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
  assert.equal(value.value.usage.by_role.reader.calls, 1); assert.match(JSON.stringify(value.requests[2]), /budget_exhausted/);
});

test('R1 protected changes are returned and clearing them completes', async () => {
  const value = await scenario([{ tool: 'run', args: { command: "Add-Content long.txt 'changed'", timeout_s: 10 } }, finishStep, { tool: 'run', args: { command: "[IO.File]::WriteAllText((Join-Path (Get-Location) 'long.txt'), (('0123456789' * 10 + \"`n\") * 250))", timeout_s: 10 } }, finishStep], { scope: { protected: ['long.txt'] } }, false, repository);
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
  assert.equal(value.value.continues, 1); assert.match(JSON.stringify(value.requests[2]), /protected.*long\.txt/);
});

test('R2 detects violations and accepts an ordinary change', async () => {
  const command = "New-Item -ItemType Directory app | Out-Null; Set-Content app/good.txt 'ordinary'; Set-Content app/new.md 'doc'; Set-Content app/package.json '{\"dependencies\":{\"x\":\"1\"}}'; Set-Content app/bad.ts \"@ts-ignore`nTODO\"; Set-Content app/Cargo.toml \"[dependencies]`nfoo = '1'\"; Set-Content app/pyproject.toml \"[project]`nname = 'x'\"; Set-Content outside.txt 'outside'";
  const value = await scenario([{ tool: 'run', args: { command, timeout_s: 10 } }, finishStep], { max_continues: 0, scope: { allow: ['app/**'] } }, false, repository);
  assert.equal(value.value.status, 'needs_judgment', JSON.stringify(value.value));
  for (const [id, file, line] of [['out_of_scope', 'outside.txt', 1], ['new_doc', 'app/new.md', 1], ['new_dep', 'app/package.json', 1], ['suppression', 'app/bad.ts', 1], ['leftover', 'app/bad.ts', 2]]) assert.ok(value.value.violations.some((v: any) => v.id === id && v.path === file && v.line === line), id + JSON.stringify(value.value));
  assert.match(value.value.reason, /new_doc: app\/new\.md:1 \(this task does not allow new README/);
  assert.ok(!value.value.violations.some((v: any) => v.path === 'app/good.txt'));
  assert.ok(value.value.violations.some((v: any) => v.id === 'new_dep' && v.path === 'app/Cargo.toml'));
  assert.ok(!value.value.violations.some((v: any) => v.path === 'app/pyproject.toml'));
});

test('R3 repeated suspicious size requires judgment', async () => {
  const value = await scenario([{ tool: 'run', args: { command: "Set-Content new.txt 'hello'", timeout_s: 10 } }, finishStep, finishStep], { scope: { max_added_lines: 0 } }, false, repository);
  assert.equal(value.value.status, 'needs_judgment', JSON.stringify(value.value)); assert.equal(value.value.continues, 1);
  assert.ok(value.value.violations.some((v: any) => v.id === 'too_large'));
});

test('R3 multiline empty catch is suspicious but a handled exception is not', () => {
  const checked = inspectDiff({ num: '', patch: '', untracked: [{ path: 'a.cs', content: 'try {}\ncatch (Exception) {\n}\n' }, { path: 'b.cs', content: 'catch (Exception) {\n  throw;\n}\n' }] });
  assert.deepEqual(checked.violations, [{ id: 'swallow', path: 'a.cs', line: 2, kind: 'suspect' }]);
});

test('R4 dirty workspace fails before sending to the model', async () => {
  const value = await scenario([finishStep], {}, false, work => { repository(work); writeFileSync(path.join(work, 'dirty.txt'), 'dirty'); });
  assert.equal(value.value.status, 'failed', JSON.stringify(value.value)); assert.match(value.value.reason, /uncommitted/); assert.equal(value.requests.length, 0);
});

test('R6 Japanese file names keep their own violations', async () => {
  const command = "Add-Content other.txt 'plain'; Add-Content 日本語.ts '// @ts-ignore'";
  const value = await scenario([{ tool: 'run', args: { command, timeout_s: 10 } }, finishStep], { max_continues: 0 }, false, work => {
    writeFileSync(path.join(work, 'other.txt'), 'one\n'); writeFileSync(path.join(work, '日本語.ts'), 'two\n'); repository(work);
  });
  assert.equal(value.value.status, 'needs_judgment', JSON.stringify(value.value));
  assert.ok(value.value.diff.files.includes('日本語.ts'), JSON.stringify(value.value.diff));
  assert.deepEqual(value.value.violations.map((v: any) => [v.id, v.path]), [['suppression', '日本語.ts']]);
});

test('R7 a lockfile is reported once and a long list is cut in the prompt', async () => {
  const lock = inspectDiff({ num: '3\t0\tpackage-lock.json\0', patch: '+++ b/package-lock.json\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n', untracked: [] });
  assert.deepEqual(lock.violations.map(v => v.id), ['new_dep']);
  const lines = Array.from({ length: 40 }, () => '// TODO').join("`n");
  const value = await scenario([{ tool: 'run', args: { command: `Set-Content many.ts "${lines}"`, timeout_s: 10 } }, finishStep, finishStep], { max_continues: 1 }, false, repository);
  assert.equal(value.value.violations.length, 40, JSON.stringify(value.value));
  const prompt = JSON.stringify(value.requests[2]);
  assert.match(prompt, /and 10 more violations/); assert.equal(prompt.match(/leftover: many\.ts/g)?.length, 30);
});

test('R8 a CRLF checkout follows the host autocrlf setting', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/autocrlf-'));
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  const run = async (hostValue: string) => {
    const config = path.join(root, `gitconfig-${hostValue}`);
    writeFileSync(config, `[core]\n\tautocrlf = ${hostValue}\n`);
    process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = '1';
    return scenario([finishStep], {}, false, work => {
      writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n');
      const git = ['-C', work, '-c', 'core.autocrlf=true', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid'];
      execFileSync('git', ['init', '-q', work]);
      execFileSync('git', [...git, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', [...git, 'commit', '-qm', 'initial']);
      rmSync(path.join(work, 'a.txt'));
      execFileSync('git', [...git, 'checkout', '--', 'a.txt']);
      assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'one\r\ntwo\r\n');
    });
  };
  try {
    const same = await run('true');
    assert.equal(same.value.status, 'completed', JSON.stringify(same.value));
    assert.deepEqual(same.value.diff.files, []);
    const other = await run('false');
    assert.equal(other.value.status, 'failed', JSON.stringify(other.value));
    assert.match(other.value.reason, /uncommitted/); assert.equal(other.requests.length, 0);
  } finally {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a non-number budget is rejected before anything is sent', async () => {
  const value = await scenario([finishStep], { max_quota_percent: 'lots' });
  assert.equal(value.value.status, 'failed', JSON.stringify(value.value));
  assert.match(value.value.reason, /max_quota_percent/); assert.equal(value.requests.length, 0);
});

test('R5 control: a planted fsmonitor really runs when git is used on the host', () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/fsmonitor-'));
  try {
    const work = path.join(root, 'work'); mkdirSync(work); writeFileSync(path.join(work, 'a.txt'), 'a\n'); repository(work);
    const marker = path.join(root, 'marker');
    execFileSync('git', ['-C', work, 'config', 'core.fsmonitor', `cmd /c echo marked > "${marker}"`]);
    execFileSync('git', ['-C', work, 'status', '--short'], { stdio: 'ignore' });
    assert.equal(existsSync(marker), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R5 git fsmonitor configuration is never executed on the host', async () => {
  let marker = '';
  const value = await scenario([finishStep], {}, false, (work, root) => {
    repository(work); marker = path.join(root, 'marker');
    execFileSync('git', ['-C', work, 'config', 'core.fsmonitor', `cmd /c echo marked > "${marker}"`]);
  });
  assert.equal(value.value.status, 'completed', JSON.stringify(value.value));
  assert.equal(value.requests.length, 1); assert.equal(value.value.diff.files.length, 0);
  assert.equal(value.markerExists, false);
});

test('G7 compaction requests pass through the gate and count usage', async () => {
  const inspect = { tool: 'inspect', args: { reads: [{ path: 'long.txt' }] } };
  const value = await scenario([...Array(9).fill(inspect), { text: 'working', input: 155000 }, { text: 'summary', input: 40 }], { goal: 'large task', max_quota_percent: 10, max_continues: 0 });
  assert.equal(value.value.status, 'needs_judgment', JSON.stringify(value.value));
  assert.ok(value.requests.length >= 11, JSON.stringify({ result: value.value, count: value.requests.length, stderr: value.stderr }));
  assert.equal(value.ledger.filter(row => row.sha256).length, value.requests.length);
  assert.equal(value.value.usage.calls, value.requests.length);
  assert.equal(value.value.usage.input, 155200 + (value.requests.length - 11) * 20);
  assert.equal(value.value.usage.cached, value.requests.length * 10);
  assert.equal(value.value.usage.output, value.requests.length * 5);
  assert.ok(value.requests.slice(1).some(request => !request.tools && !JSON.stringify(request.input).includes('additional_tools')));
});

test('gate validates requests before fetch and syncs the ledger', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/gate-'));
  const original = globalThis.fetch;
  let received = 0;
  globalThis.fetch = async () => { received++; return new Response('ok'); };
  const terms = path.join(root, 'terms');
  const ledger = path.join(root, 'ledger');
  writeFileSync(terms, 'secret-name\n');
  let quota = 0;
  const config = { allowedHosts: ['localhost:1234'], forbiddenTermsFile: terms, model: 'model', effort: 'medium', tools: ['inspect'], ledgerPath: ledger, maxQuotaPercent: 1, quotaPercent: () => quota };
  const restore = installGate(config);
  const send = (body: unknown) => fetch('http://localhost:1234/v1/responses', { method: 'POST', body: JSON.stringify(body) });
  const valid = { model: 'model', reasoning: { effort: 'medium' }, tools: [{ type: 'function', name: 'inspect' }] };
  try {
    await assert.rejects(send({ ...valid, input: 'ＳＥＣＲＥＴ-name' }), (e: unknown) => e instanceof GateBlocked && e.reason === 'forbidden_term');
    await assert.rejects(fetch('http://localhost:1234/v1/responses', { method: 'POST', body: '{"model":"model","reasoning":{"effort":"medium"},"input":"secret\\u002dname"}' }), (e: unknown) => e instanceof GateBlocked && e.reason === 'forbidden_term');
    await assert.rejects(send({ ...valid, model: 'other' }), (e: unknown) => e instanceof GateBlocked && e.reason === 'model_mismatch');
    await assert.rejects(send({ ...valid, reasoning: { effort: 'high' } }), (e: unknown) => e instanceof GateBlocked && e.reason === 'model_mismatch');
    await assert.rejects(send({ ...valid, tools: [{ type: 'web_search' }] }), (e: unknown) => e instanceof GateBlocked && e.reason === 'tool_not_declared');
    await assert.rejects(send({ ...valid, input: [{ type: 'additional_tools', tools: [{ type: 'function', name: 'unknown' }] }] }), (e: unknown) => e instanceof GateBlocked && e.reason === 'tool_not_declared');
    await assert.rejects(fetch('http://other.invalid/'));
    assert.throws(() => new WebSocket('ws://localhost:1234'));
    quota = 2;
    await assert.rejects(send(valid), BudgetExhausted);
    assert.equal(received, 0);
    quota = 0;
    await send(valid);
    assert.equal(received, 1);
    await restore.flush();
    assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.sha256).length, 1);
  } finally {
    restore(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true });
  }
});

test('gate permits absent reasoning when declared and blocks malformed JSON', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/gate-'));
  const original = globalThis.fetch;
  let received = 0;
  globalThis.fetch = async () => { received++; return new Response('ok'); };
  const restore = installGate({ allowedHosts: ['localhost:1234'], model: 'model', effort: undefined, tools: [], ledgerPath: path.join(root, 'ledger'), maxQuotaPercent: 1 });
  try {
    await assert.rejects(fetch('http://localhost:1234/responses', { method: 'POST', body: '{' }), GateBlocked);
    await fetch('http://localhost:1234/responses', { method: 'POST', body: JSON.stringify({ model: 'model' }) });
    await restore.flush(); assert.equal(received, 1);
  } finally { restore(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('D3 gate rejects models outside the declared profiles', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/profiles-'));
  const original = globalThis.fetch; let received = 0;
  globalThis.fetch = async () => { received++; return new Response('ok'); };
  const restore = installGate({ allowedHosts: ['localhost:1234'], profiles: [{ model: 'parent', effort: 'medium', tools: ['delegate'] }, { model: 'child', effort: 'low', tools: ['finish'] }], ledgerPath: path.join(root, 'ledger'), maxQuotaPercent: 1 });
  const send = (model: string) => fetch('http://localhost:1234/responses', { method: 'POST', body: JSON.stringify({ model, reasoning: { effort: 'low' }, tools: [{ type: 'function', name: 'finish' }] }) });
  try {
    await assert.rejects(send('undeclared'), (error: unknown) => error instanceof GateBlocked && error.reason === 'model_mismatch');
    await send('child'); await restore.flush(); assert.equal(received, 1);
  } finally { restore(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('CLI talks to a local Responses server without finish', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-cli-'));
  const work = path.join(root, 'work');
  const agent = path.join(root, 'agent');
  mkdirSync(work); mkdirSync(agent);
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const response = { id: 'response_1', status: 'completed', output: [], usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 35 } };
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const taskFile = path.join(root, 'task.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'test', goal: 'hello', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', read_roots: [], forbidden_terms_file: null, max_quota_percent: 1, max_continues: 0, base_url: `http://127.0.0.1:${address.port}/v1` }));
  let runDir: string | undefined;
  try {
    const child = spawn(process.execPath, ['src/cli.ts', 'run', taskFile], { cwd: process.cwd(), env: { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake-test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 1, stderr);
    assert.equal(stdout.trim().split('\n').length, 1);
    const value = JSON.parse(stdout);
    runDir = value.run_dir;
    assert.equal(value.status, 'needs_judgment', stdout + stderr);
    assert.equal(requests.length, 1);
    assert.equal(value.usage.input, 20); assert.equal(value.usage.cached, 10); assert.equal(value.usage.output, 5);
    assert.ok(runDir);
    assert.doesNotMatch(readFileSync(path.join(runDir, 'ledger.jsonl'), 'utf8'), /fake-test-key/);
    assert.doesNotMatch(readFileSync(path.join(runDir, 'result.json'), 'utf8'), /fake-test-key/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing terms and unwritable ledger fail closed', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/gate-'));
  const original = globalThis.fetch;
  let received = 0;
  globalThis.fetch = async () => { received++; return new Response('ok'); };
  const config = { allowedHosts: ['localhost:1234'], forbiddenTermsFile: path.join(root, 'missing'), model: 'model', effort: 'medium', tools: [], ledgerPath: root, maxQuotaPercent: 1, quotaPercent: () => 0 };
  try {
    assert.throws(() => installGate(config));
    const restore = installGate({ ...config, forbiddenTermsFile: null });
    try {
      await assert.rejects(fetch('http://localhost:1234/responses', { method: 'POST', body: JSON.stringify({ model: 'model', reasoning: { effort: 'medium' } }) }));
      assert.equal(received, 0);
    } finally { restore(); }
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('CLI executes inspect and finish using scripted Responses', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-loop-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(work); mkdirSync(agent); writeFileSync(path.join(work, 'sample.txt'), 'loop-control\n');
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const name = requests.length === 1 ? 'inspect' : 'finish';
      const args = name === 'inspect' ? { reads: [{ path: 'sample.txt' }] } : { state: 'done', summary: 'finished' };
      const item = { type: 'function_call', id: `item_${requests.length}`, call_id: `call_${requests.length}`, name, arguments: JSON.stringify(args), status: 'completed' };
      const response = { id: `resp_${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 35 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const taskFile = path.join(root, 'task.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'loop', goal: 'read the sample', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', read_roots: [], forbidden_terms_file: null, max_quota_percent: 1, base_url: `http://127.0.0.1:${address.port}/v1` }));
  let runDir: string | undefined;
  try {
    const child = spawn(process.execPath, ['src/cli.ts', 'run', taskFile], { env: { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake-test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const value = JSON.parse(stdout); runDir = value.run_dir;
    assert.equal(value.status, 'completed', stdout + stderr);
    assert.equal(value.state, 'done'); assert.equal(value.summary, 'finished');
    assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1]), /loop-control/);
    assert.equal(value.usage.calls, 2); assert.equal(value.usage.input, 40); assert.equal(value.usage.cached, 20); assert.equal(value.usage.output, 10); assert.equal(value.usage.reasoning, 4);
    const fixedParts = (requests[0].input as Array<{ type?: string; role?: string }>).filter(item => item.type === 'additional_tools' || item.role === 'developer');
    const fixed = JSON.stringify(fixedParts).length;
    console.log(`G10 fixed characters: ${fixed}`); assert.ok(fixed <= 8000);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('boxed inspect, edit and run controls', async () => {
  mkdirSync('.test-tmp', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-tmp/tools-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run');
  mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'a.txt'), Buffer.from('\ufeffone\r\ntwo\r\nthree\r\n'));
  writeFileSync(path.join(work, 'b.txt'), 'alpha\nbeta\ngamma\n');
  writeFileSync(path.join(root, 'outside.txt'), 'outside-canary');
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(work, 'outside-link'), root], { stdio: 'ignore' });
  const tools = createTools({ workspace: work, readRoots: [], runDir, maxRunS: 2, finish: () => {} });
  const call = async (name: string, args: unknown) => {
    const tool = tools.find(item => item.name === name); assert.ok(tool);
    const value = await tool.execute('test', args as never, undefined, undefined, {} as never);
    const content = value.content[0]; assert.equal(content.type, 'text');
    return JSON.parse(content.text);
  };
  const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  try {
    const inspected = await call('inspect', { reads: [{ path: 'a.txt', ranges: [[1, 1], [3, 3]] }, { path: 'b.txt', ranges: [[2, 2]] }, { path: path.join(root, 'outside.txt') }, { path: '../outside.txt' }, { path: 'outside-link/outside.txt' }] });
    assert.equal(inspected.reads[0].sha256, digest(path.join(work, 'a.txt')));
    assert.deepEqual(inspected.reads[0].lines, ['1: one', '3: three']);
    assert.deepEqual(inspected.reads[1].lines, ['2: beta']);
    assert.ok(inspected.reads[2].error); assert.ok(inspected.reads[3].error); assert.ok(inspected.reads[4].error);
    const bad = await call('edit', { path: 'a.txt', expected_hash: 'wrong', replacements: [{ old: 'one', new: '日本語' }] });
    assert.equal(bad.error, 'hash_mismatch');
    const updated = await call('edit', { path: 'a.txt', expected_hash: digest(path.join(work, 'a.txt')), replacements: [{ old: 'one', new: '日本語\n次' }] });
    assert.equal(updated.sha256, digest(path.join(work, 'a.txt')));
    assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), '\ufeff日本語\r\n次\r\ntwo\r\nthree\r\n');
    const lf = await call('edit', { path: 'b.txt', expected_hash: digest(path.join(work, 'b.txt')), replacements: [{ old: 'beta', new: '日本語\n次' }] });
    assert.equal(lf.sha256, digest(path.join(work, 'b.txt'))); assert.equal(readFileSync(path.join(work, 'b.txt'), 'utf8'), 'alpha\n日本語\n次\ngamma\n');
    const duplicate = await call('edit', { path: 'b.txt', expected_hash: digest(path.join(work, 'b.txt')), replacements: [{ old: 'a', new: 'x' }] });
    assert.equal(duplicate.error, 'replacement_not_unique');
    const largeContent = 'あ'.repeat(35000);
    const created = await call('edit', { path: 'nested/new.txt', content: largeContent });
    assert.equal(created.sha256, digest(path.join(work, 'nested/new.txt')));
    assert.equal(readFileSync(path.join(work, 'nested/new.txt'), 'utf8'), largeContent);
    writeFileSync(path.join(work, 'sjis.txt'), Buffer.from([0x82, 0xa0]));
    const sjisHash = digest(path.join(work, 'sjis.txt'));
    const sjis = await call('edit', { path: 'sjis.txt', expected_hash: sjisHash, replacements: [{ old: 'x', new: 'y' }] });
    assert.equal(sjis.error, 'not_utf8'); assert.equal(digest(path.join(work, 'sjis.txt')), sjisHash);
    writeFileSync(path.join(work, 'huge.txt'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const huge = await call('inspect', { reads: [{ path: 'huge.txt' }] }); assert.equal(huge.reads[0].error, 'too_large');
    writeFileSync(path.join(work, 'longline.txt'), 'x'.repeat(2000));
    const longline = await call('inspect', { reads: [{ path: 'longline.txt' }] }); assert.match(longline.reads[0].lines[0], /\[truncated\]/);
    writeFileSync(path.join(work, 'long.txt'), 'long line\n'.repeat(4000));
    const truncated = await call('inspect', { reads: [{ path: 'long.txt' }] });
    assert.equal(truncated.truncated, true); assert.equal(truncated.reads[0].truncated, true);
    const run = await call('run', { command: 'Write-Output "日本語"; exit 7', timeout_s: 10 });
    assert.equal(run.exit_code, 7); assert.match(run.tail.join('\n'), /日本語/);
    const log = await call('inspect', { log: { run_id: run.run_id } });
    assert.match(log.reads[0].lines.join('\n'), /日本語/);
    const timed = await call('run', { command: 'Start-Sleep -Seconds 5', timeout_s: 1 });
    assert.equal(timed.status, 'timeout');
    const capped = await call('run', { command: 'Start-Sleep -Seconds 5', timeout_s: 100 });
    assert.equal(capped.status, 'timeout'); assert.ok(capped.duration_ms < 5000);
    const verbose = await call('run', { command: '1..80 | ForEach-Object { Write-Output ("error " + ("x" * 1500)) }', timeout_s: 10 });
    assert.ok(Buffer.byteLength(JSON.stringify(verbose)) <= 16384); assert.ok(verbose.truncated);
    assert.ok(verbose.tail.every((line: string) => line.length <= 512));
    process.env.BOX_TEST_SECRET_TOKEN = 'secret-box-value';
    const environment = await call('run', { command: 'if ($env:BOX_TEST_SECRET_TOKEN) { Write-Output $env:BOX_TEST_SECRET_TOKEN }; Write-Output $env:TEMP', timeout_s: 10 });
    assert.doesNotMatch(environment.tail.join('\n'), /secret-box-value/); assert.ok(environment.tail.join('\n').length > 0);
  } finally { delete process.env.BOX_TEST_SECRET_TOKEN; rmSync(root, { recursive: true, force: true }); }
});
