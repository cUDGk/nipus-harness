import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '../src/mcp.ts';
import { hostJob, lockOwner, lockPath, removeLock, takeLock } from '../src/host.ts';
import { createTools } from '../src/tools.ts';

const script = path.resolve('tests/fake-mcp.mjs');
test('MCP tools, errors, timeout, logs and private arguments', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  process.env.FAKE_SECRET = 'never-send'; process.env.DATABASE_URL = 'never-send'; process.env.FAKE_CONNECTION_STRING = 'never-send';
  const server = new McpServer('fake', { command: [process.execPath, script], tools: ['echo'], timeout_s: 0.1, env: { ALLOWED: 'yes' } }, dir);
  try {
    const defs = await server.list();
    const call = async (name: string, args: any = {}) => server.tool(defs.find(d => d.name === name)).execute('id', args, undefined, undefined, {} as never);
    const echoed = await call('echo', { private: 'hidden-argument' });
    assert.match(JSON.stringify(echoed), /hidden-argument/);
    const image = await call('image'); assert.equal(image.content[1].type, 'image');
    assert.equal(JSON.parse((image.content[0] as any).text).images, 1); // Never an empty text part.
    assert.match(JSON.stringify(await call('ask')), /pong-seen/); // A server's ping is not taken for the call's reply.
    assert.match(JSON.stringify(await call('rpcfail')), /bad arg canary/); // The worker sees why a call was refused.
    assert.match(JSON.stringify(await call('rpcodd')), /mcp_tool_error/); // An odd error shape does not take the CLI down.
    const patterned = server.tool(defs.find(d => d.name === 'patterned')).parameters as any;
    assert.deepEqual(patterned, { type: 'object', properties: { pattern: { type: 'string' }, other: { type: 'string' } } });
    const long = await call('long'); const summary = JSON.parse((long.content[0] as any).text);
    assert.match(readFileSync(path.join(dir, 'logs', summary.run_id + '.log'), 'utf8'), /long/);
    const workspace = path.join(dir, 'work'); mkdirSync(workspace);
    const inspect = createTools({ workspace, readRoots: [], runDir: dir, box: 'none', finish: () => {} }).find(t => t.name === 'inspect')!;
    const inspected = await inspect.execute('id', { log: { run_id: summary.run_id } } as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(inspected), /long/);
    assert.match(JSON.stringify(await call('fail')), /mcp_tool_error/);
    assert.match(JSON.stringify(await call('slow')), /mcp_timeout/);
    const env = JSON.stringify(await call('environment')); assert.doesNotMatch(env, /never-send/); assert.match(env, /yes/); assert.match(env, /mcp.*fake/);
    assert.doesNotMatch(readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8'), /hidden-argument/);
    assert.match(JSON.stringify(await call('die')), /mcp_server_exited/);
    assert.match(JSON.stringify(await call('echo')), /mcp_server_exited/);
  } finally {
    await server.close();
    delete process.env.FAKE_SECRET; delete process.env.DATABASE_URL; delete process.env.FAKE_CONNECTION_STRING;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closing a server stops the helpers it started, and a list without end is refused', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-close-'));
  const server = new McpServer('fake', { command: [process.execPath, script, 'stubborn'], tools: ['helper'] }, dir);
  const endless = new McpServer('list', { command: [process.execPath, script, 'endless'], tools: ['x'] }, dir);
  try {
    const defs = await server.list();
    const reply = await server.tool(defs.find(d => d.name === 'helper')).execute('id', {}, undefined, undefined, {} as never);
    const helper = Number((reply.content[0] as any).text);
    assert.ok(helper > 0); process.kill(helper, 0);
    const pid = server.child.pid!;
    await server.close();
    assert.throws(() => process.kill(pid, 0)); assert.throws(() => process.kill(helper, 0));
    await assert.rejects(endless.list(), /bad_tool_list/);
  } finally { await server.close(); await endless.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('declared MCP tools reach the model and results return on the next request', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mcp-run-')); const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  const requests: any[] = [];
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      requests.push(JSON.parse(body)); const n = requests.length;
      const names = ['image', 'echo', 'fail', 'slow', 'die', 'echo'];
      const name = n <= names.length ? `mcp__fake__${names[n - 1]}` : 'finish';
      const args = n === 2 ? { private: 'ledger-canary' } : n <= names.length ? {} : { state: 'done', summary: 'done' };
      const item = { type: 'function_call', id: `i${n}`, call_id: `c${n}`, name, arguments: JSON.stringify(args), status: 'completed' };
      const response = { id: `r${n}`, status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 5 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address(); assert.ok(address && typeof address !== 'string');
  const task = { id: 'mcp-integration', goal: 'test', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', box: 'none', read_roots: [], max_quota_percent: 10, base_url: `http://127.0.0.1:${address.port}/v1`, mcp: { fake: { command: [process.execPath, script], tools: ['image', 'echo', 'fail', 'slow', 'die'], timeout_s: 0.1 } } };
  const file = path.join(root, 'task.json'); writeFileSync(file, JSON.stringify(task)); let runDir = '';
  try {
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { env: { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    const code = await new Promise(resolve => child.on('close', resolve)); assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout); runDir = result.run_dir; assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.match(JSON.stringify(requests[0]), /mcp__fake__image/); assert.doesNotMatch(JSON.stringify(requests[0]), /mcp__fake__environment/);
    assert.match(JSON.stringify(requests[1]), /data:image\//); assert.match(JSON.stringify(requests[2]), /ledger-canary/);
    assert.match(JSON.stringify(requests[3]), /mcp_tool_error/); assert.match(JSON.stringify(requests[4]), /mcp_timeout/); assert.match(JSON.stringify(requests[5]), /mcp_server_exited/); assert.match(JSON.stringify(requests[6]), /mcp_server_exited/);
    assert.doesNotMatch(readFileSync(path.join(runDir, 'ledger.jsonl'), 'utf8'), /ledger-canary/);
  } finally { await new Promise<void>(resolve => model.close(() => resolve())); if (runDir) rmSync(runDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('task validation and mcp-tools', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mcp-validation-')); const work = path.join(root, 'work'); mkdirSync(work);
  const base: any = { id: 'mcp-validation', goal: 'test', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', box: 'none', read_roots: [], mcp: { fake: { command: [process.execPath, script], tools: ['not-present'] } } };
  const file = path.join(root, 'task.json');
  const run = (task: any, command = 'run') => { writeFileSync(file, JSON.stringify(task));
    const child = spawnSync(process.execPath, [path.resolve('src/cli.ts'), command, file],
      { encoding: 'utf8', env: { ...process.env, HARNESS_QUOTA_COMMAND: '' } });
    assert.equal(child.status, command === 'run' ? 1 : 0); return child.stdout; };
  try {
    assert.match(run(base, 'mcp-tools'), /"tool":"echo"/);
    for (const mcp of [{ fake: { command: [process.execPath], tools: [] } }, { fake: { command: [process.execPath], tools: ['a', 'a'] } }, { fake: { command: [process.execPath], tools: ['x'.repeat(60)] } }, { fake: { command: [process.execPath], tools: ['a'], bad: true } }]) assert.equal(JSON.parse(run({ ...base, mcp })).reason, 'Invalid mcp');
    assert.equal(JSON.parse(run({ ...base, clean_room: { manifest: path.join(root, 'manifest') } })).status, 'quarantined');
    assert.equal(JSON.parse(run({ ...base, box: 'mxc', mcp: { fake: { command: [path.join(work, 'bad.exe')], tools: ['a'] } } })).reason, 'Invalid mcp');
    assert.equal(JSON.parse(run({ ...base, box: 'mxc', mcp: { fake: { command: [process.execPath, path.join(work, 'bad.js')], tools: ['a'] } } })).reason, 'Invalid mcp');
    assert.equal(JSON.parse(run({ ...base, box: 'mxc', mcp: { fake: { command: [process.execPath], tools: ['a'], env: { NODE_OPTIONS: `--require=${path.join(work, 'p.cjs')}` } } } })).reason, 'Invalid mcp');
    assert.equal(JSON.parse(run({ ...base, mcp: { a__b: { command: [process.execPath], tools: ['c'] } } })).reason, 'Invalid mcp');
    for (const arg of [`--entry=${path.join(work, 'bad.js')}`, `--entry=${work.replace(/\\/g, '/').toUpperCase()}/bad.js`]) {
      assert.equal(JSON.parse(run({ ...base, box: 'mxc', mcp: { fake: { command: [process.execPath, arg], tools: ['a'] } } })).reason, 'Invalid mcp', arg);
    }
    // Listing names does not wait in line for a lock someone else holds.
    const held = lockPath(`mcp:mcp-tools-test-${process.pid}`); assert.ok(takeLock(held, lockOwner(root, 'test')));
    try { assert.match(run({ ...base, host_queue_timeout_s: 3600, mcp: { fake: { command: [process.execPath, script], tools: ['echo'], lock: `mcp-tools-test-${process.pid}` } } }, 'mcp-tools'), /"tool":"echo"/); }
    finally { removeLock(held); }
    const missing = JSON.parse(run(base)); assert.equal(missing.status, 'failed'); assert.match(missing.reason, /fake.*not-present/); if (missing.run_dir) rmSync(missing.run_dir, { recursive: true, force: true });
    for (const config of [{ command: ['no-such-mcp-executable.exe'], tools: ['echo'] }, { command: [process.execPath, script, 'hang'], tools: ['echo'], start_timeout_s: 0.1 }]) {
      const failed = JSON.parse(run({ ...base, mcp: { fake: config } })); assert.equal(failed.status, 'failed'); assert.match(failed.reason, /fake/); if (failed.run_dir) rmSync(failed.run_dir, { recursive: true, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('locks wait and time out, stop and resume reconnect, and killed CLIs are reaped', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mcp-lock-')); const agent = path.join(root, 'agent'); mkdirSync(agent);
  const dirs: string[] = []; const held: http.ServerResponse[] = []; let finish = false;
  const model = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    if (!finish) { held.push(res); return; }
    const item = { type: 'function_call', id: 'i', call_id: 'c', name: 'finish', arguments: JSON.stringify({ state: 'done', summary: 'done' }), status: 'completed' };
    const response = { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 5 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end([{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
  }); });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve)); const address = model.address(); assert.ok(address && typeof address !== 'string');
  const env = { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' };
  const cli = (args: string[]) => { const child = spawn(process.execPath, [path.resolve('src/cli.ts'), ...args], { env }); let out = ''; child.stdout.on('data', c => out += c); const done = new Promise<any>(resolve => child.on('close', () => resolve(out ? JSON.parse(out) : null))); return { child, done }; };
  const makeTask = (id: string, timeout: number) => { const work = path.join(root, id); mkdirSync(work); const file = path.join(root, id + '.json'); writeFileSync(file, JSON.stringify({ id, goal: 'test', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', box: 'none', max_quota_percent: 10, base_url: `http://127.0.0.1:${address.port}/v1`, host_queue_timeout_s: timeout, mcp: { fake: { command: [process.execPath, script, 'stubborn'], tools: ['echo'], lock: 'mcp-test-lock' } } })); return file; };
  const firstFile = makeTask('mcp-lock-first', 10); const secondFile = makeTask('mcp-lock-second', 0.5); const killFile = makeTask('mcp-kill', 10); const waitingFile = makeTask('mcp-lock-waiting', 30);
  const wait = async (condition: () => boolean) => { const end = Date.now() + 30000; while (!condition()) { if (Date.now() > end) throw new Error('wait timed out'); await new Promise(r => setTimeout(r, 100)); } };
  const runs = path.resolve('runs'); const find = (id: string) => readdirSync(runs).find(n => n.startsWith(id + '-'));
  let first: ReturnType<typeof cli> | undefined; let killed: ReturnType<typeof cli> | undefined;
  try {
    first = cli(['run', firstFile]); await wait(() => held.length > 0); const firstName = find('mcp-lock-first'); assert.ok(firstName); const firstDir = path.join(runs, firstName); dirs.push(firstDir);
    const firstPid = JSON.parse(readFileSync(path.join(firstDir, 'mcp/fake/process.json'), 'utf8')).pid;
    const second = await cli(['run', secondFile]).done; if (second.run_dir) dirs.push(second.run_dir); assert.equal(second.reason, 'mcp_lock_timeout');
    const waiting = cli(['run', waitingFile]); await wait(() => !!find('mcp-lock-waiting')); const waitingDir = path.join(runs, find('mcp-lock-waiting')!); dirs.push(waitingDir);
    await new Promise(r => setTimeout(r, 1000)); assert.equal(readdirSync(waitingDir).includes('mcp'), false);
    const stopped = JSON.parse(execFileSync(process.execPath, [path.resolve('src/cli.ts'), 'stop', firstDir], { encoding: 'utf8', env })); assert.ok(stopped.pids.length); await first.done;
    assert.throws(() => process.kill(firstPid, 0));
    finish = true; const waited = await waiting.done; assert.equal(waited.status, 'completed', JSON.stringify(waited));
    const resumed = await cli(['resume', firstDir]).done; assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
    finish = false; killed = cli(['run', killFile]); await wait(() => held.length > 1); const killName = find('mcp-kill'); assert.ok(killName); const killDir = path.join(runs, killName); dirs.push(killDir);
    const pid = JSON.parse(readFileSync(path.join(killDir, 'mcp/fake/process.json'), 'utf8')).pid; killed.child.kill(); await killed.done;
    await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    execFileSync(process.execPath, [path.resolve('src/cli.ts'), 'stop', killDir], { encoding: 'utf8', env }); assert.throws(() => process.kill(pid, 0));
  } finally { for (const res of held) res.destroy(); if (first && first.child.exitCode === null) first.child.kill(); if (killed && killed.child.exitCode === null) killed.child.kill(); await new Promise<void>(resolve => model.close(() => resolve())); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});


test('MCP calls invalidate a host job pass', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mcp-activity-')); const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'base'), 'base'); execFileSync('git', ['init', '-q', work]); execFileSync('git', ['-C', work, 'add', '.']); execFileSync('git', ['-C', work, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  const count = path.join(root, 'count'); const task = { workspace: work, box: 'none' as const, host_jobs: { job: { command: [process.execPath, '-e', "require('fs').appendFileSync(process.argv[1],'x')", count], timeout_s: 30, lock: `mcp-activity-${process.pid}`, output: 'tail' as const } } };
  const server = new McpServer('fake', { command: [process.execPath, script], tools: ['echo'] }, runDir);
  try {
    const def = (await server.list()).find(d => d.name === 'echo'); assert.equal((await hostJob(task, runDir, 'job', {}, true)).status, 'passed'); assert.equal((await hostJob(task, runDir, 'job', {}, true)).reused, true);
    await server.tool(def).execute('id', {}, undefined, undefined, {} as never);
    assert.equal((await hostJob(task, runDir, 'job', {}, true)).reused, undefined); assert.equal(readFileSync(count, 'utf8'), 'xx');
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('only roles declaring an MCP tool receive it and share the parent connection', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mcp-roles-')); const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  const requests: any[] = [];
  const steps = [
    { name: 'delegate', args: { role: 'allowed', task: 'call the tool' } },
    { name: 'mcp__fake__echo', args: { child: 'role-canary' } },
    { name: 'finish', args: { state: 'done', summary: 'child done' } },
    { name: 'delegate', args: { role: 'denied', task: 'finish' } },
    { name: 'finish', args: { state: 'done', summary: 'child done' } },
    { name: 'finish', args: { state: 'done', summary: 'parent done' } },
  ];
  const model = http.createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
    requests.push(JSON.parse(body)); const n = requests.length; const step = steps[n - 1]; assert.ok(step);
    const item = { type: 'function_call', id: `i${n}`, call_id: `c${n}`, name: step.name, arguments: JSON.stringify(step.args), status: 'completed' };
    const response = { id: `r${n}`, status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 5 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end([{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
  }); });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve)); const address = model.address(); assert.ok(address && typeof address !== 'string');
  const file = path.join(root, 'task.json'); writeFileSync(file, JSON.stringify({ id: 'mcp-roles', goal: 'test', workspace: work, model: 'gpt-6.1-terra', effort: 'medium', box: 'none', max_quota_percent: 10, base_url: `http://127.0.0.1:${address.port}/v1`, mcp: { fake: { command: [process.execPath, script], tools: ['echo'] } }, roles: { allowed: { model: 'gpt-6.1-terra', effort: 'medium', tools: ['finish', 'mcp__fake__echo'], max_quota_percent: 5 }, denied: { model: 'gpt-6.1-terra', effort: 'medium', tools: ['finish'], max_quota_percent: 5 } } }));
  let runDir = '';
  try {
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { env: { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } }); let out = ''; let err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, err); const result = JSON.parse(out); runDir = result.run_dir; assert.equal(result.status, 'completed', out);
    assert.match(JSON.stringify(requests[1]), /mcp__fake__echo/); assert.match(JSON.stringify(requests[2]), /role-canary/); assert.doesNotMatch(JSON.stringify(requests[4]), /mcp__fake__echo/);
    const ledger = readFileSync(path.join(runDir, 'ledger.jsonl'), 'utf8'); assert.equal(ledger.split('\n').filter(line => line.includes('args_sha256')).length, 1);
  } finally { await new Promise<void>(resolve => model.close(() => resolve())); if (runDir) rmSync(runDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
