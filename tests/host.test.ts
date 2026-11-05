import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runPowerShell } from '../src/box.ts';
import { hostJob, type HostTask } from '../src/host.ts';
import { createHash } from 'node:crypto';
import { reap } from '../src/commands.ts';
import { createTools } from '../src/tools.ts';

test('direct execution reads outside the box and filters inherited secrets', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-direct-'));
  const workspace = path.join(root, 'work'); const scratch = path.join(root, 'scratch');
  mkdirSync(workspace); const outside = path.join(root, 'outside.txt'); writeFileSync(outside, 'outside-control');
  process.env.HARNESS_TEST_SECRET = 'hidden-control'; process.env.HOST_PUBLIC_TEST = 'public-control';
  process.env.HOST_PASSWORD = 'password-control'; process.env.HOST_APIKEY = 'apikey-control';
  process.env.HOST_API_KEY = 'api-key-control'; process.env.HOST_TOKEN = 'token-control';
  try {
    const script = `Get-Content -LiteralPath '${outside}'; Write-Output $env:HOST_PUBLIC_TEST; ` +
      `Write-Output $env:HARNESS_TEST_SECRET; Write-Output $env:HOST_PASSWORD; Write-Output $env:HOST_APIKEY; ` +
      `Write-Output $env:HOST_API_KEY; Write-Output $env:HOST_TOKEN`;
    const run = async (box: 'none' | 'mxc') => {
      const logPath = path.join(root, `${box}.log`);
      const result = await runPowerShell({ workspace, scratch, logPath, box, timeoutMs: 30000 }, script);
      return { result, text: readFileSync(logPath, 'utf8') };
    };
    const direct = await run('none');
    assert.equal(direct.result.exitCode, 0); assert.match(direct.text, /outside-control/);
    assert.match(direct.text, /public-control/);
    assert.doesNotMatch(direct.text, /hidden-control|password-control|apikey-control|api-key-control|token-control/);
    const boxed = await run('mxc');
    assert.equal(boxed.result.status, 'exited'); assert.doesNotMatch(boxed.text, /outside-control/);
  } finally {
    delete process.env.HARNESS_TEST_SECRET; delete process.env.HOST_PUBLIC_TEST;
    delete process.env.HOST_PASSWORD; delete process.env.HOST_APIKEY; delete process.env.HOST_API_KEY;
    delete process.env.HOST_TOKEN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('task environment and path override sandbox defaults with path validation', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-env-'));
  const workspace = path.join(root, 'work'); const scratch = path.join(root, 'scratch');
  const tools = path.join(root, 'tools'); mkdirSync(workspace); mkdirSync(tools);
  try {
    const logPath = path.join(root, 'log');
    const options = { workspace, scratch, logPath, timeoutMs: 30000, readRoots: [tools], path: [tools],
      env: { TEMP: 'task-temp', TEST_VALUE: 'task-control' } };
    const run = await runPowerShell(options, 'Write-Output $env:TEMP; Write-Output $env:TEST_VALUE; ' +
      'Write-Output $env:PATH');
    assert.equal(run.exitCode, 0); const text = readFileSync(logPath, 'utf8');
    assert.match(text, /task-temp/); assert.match(text, /task-control/); assert.ok(text.includes(tools));
    await assert.rejects(runPowerShell({ ...options, path: [root] }, 'Write-Output control'), /Invalid path/);
    await assert.rejects(runPowerShell({ ...options, env: { HOME: root } }, 'Write-Output control'),
      /Invalid environment/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('image tool results pass through the request gate and arrive at the server', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-image-'));
  const workspace = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(workspace); mkdirSync(agent);
  const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  writeFileSync(path.join(workspace, 'image.png'), bytes);
  const terms = path.join(root, 'terms'); writeFileSync(terms, 'image.png\n');
  let requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', part => body += part); req.on('end', () => {
      requests.push(body); const first = requests.length === 1;
      const item = { type: 'function_call', id: `i${requests.length}`, call_id: `c${requests.length}`,
        name: first ? 'inspect' : 'finish', arguments: JSON.stringify(first ? { images: ['image.png'] } :
          { state: 'done', summary: 'done' }), status: 'completed' };
      const response = { id: `r${requests.length}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const run = async (forbidden: boolean) => {
    requests = [];
    const file = path.join(root, 'task.json');
    writeFileSync(file, JSON.stringify({ id: 'image-test', goal: 'inspect an image', workspace, box: 'none',
      model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10,
      forbidden_terms_file: forbidden ? terms : null, base_url: `http://127.0.0.1:${address.port}/v1` }));
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { env: { ...process.env,
      HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
    let stdout = ''; child.stdout.on('data', data => stdout += data);
    await new Promise(resolve => child.on('close', resolve));
    const value = JSON.parse(stdout); const ledger = value.run_dir && existsSync(path.join(value.run_dir, 'ledger.jsonl'))
      ? readFileSync(path.join(value.run_dir, 'ledger.jsonl'), 'utf8') : '';
    if (value.run_dir) rmSync(value.run_dir, { recursive: true, force: true });
    return { value, ledger, bodies: [...requests] };
  };
  try {
    const allowed = await run(false);
    assert.equal(allowed.value.status, 'completed');
    assert.ok(allowed.bodies[1].includes(`data:image/png;base64,${bytes.toString('base64')}`));
    assert.ok(allowed.ledger.includes('sha256'));
    const blocked = await run(true);
    assert.equal(blocked.value.status, 'quarantined'); assert.equal(blocked.bodies.length, 1);
    assert.ok(blocked.ledger.includes('sha256'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true }); }
});

test('inspect accepts valid images and reports each invalid or excess image', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-image-errors-'));
  const workspace = path.join(root, 'work'); const runDir = path.join(root, 'run');
  mkdirSync(workspace); mkdirSync(runDir);
  try {
    writeFileSync(path.join(workspace, 'ok'), Buffer.from('ffd8ff00', 'hex'));
    writeFileSync(path.join(workspace, 'bad'), 'not an image');
    writeFileSync(path.join(workspace, 'large'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const tool = createTools({ workspace, runDir, box: 'none', readRoots: [], finish: () => {} })
      .find(item => item.name === 'inspect'); assert.ok(tool);
    const value = await tool.execute('test', { images: ['ok', 'bad', 'large', 'missing', 'ok'] } as never,
      undefined, undefined, {} as never);
    assert.equal(value.content[0].type, 'text');
    const json = JSON.parse((value.content[0] as { text: string }).text);
    assert.equal(value.content[1].type, 'image');
    assert.deepEqual(json.images.map((item: { error?: string }) => item.error),
      [undefined, 'invalid_type', 'too_large', 'ENOENT', 'too_many']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host log isolation requires the box when the worker has direct host access', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-log-isolation-'));
  const workspace = path.join(root, 'work'); const runDir = path.join(root, 'run');
  mkdirSync(workspace); mkdirSync(path.join(runDir, 'host-logs'), { recursive: true });
  const file = path.join(runDir, 'host-logs', 'synthetic.log'); writeFileSync(file, 'synthetic-private-control');
  try {
    const read = async (box: 'none' | 'mxc') => {
      const tool = createTools({ workspace, runDir, box, readRoots: [], finish: () => {} })
        .find(item => item.name === 'inspect'); assert.ok(tool);
      const value = await tool.execute('test', { reads: [{ path: file }] } as never, undefined, undefined,
        {} as never);
      return (value.content[0] as { text: string }).text;
    };
    assert.match(await read('none'), /synthetic-private-control/);
    assert.doesNotMatch(await read('mxc'), /synthetic-private-control/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host jobs reject undeclared arguments and reuse matching repository states', { timeout: 120000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-job-'));
  const workspace = path.join(root, 'work'); const runDir = path.join(root, 'run');
  mkdirSync(workspace); mkdirSync(runDir);
  try {
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(path.join(workspace, 'file'), 'initial');
    execFileSync('git', ['-C', workspace, 'add', '.']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'initial']);
    const marker = path.join(root, 'marker');
    const code = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');` +
      `fs.writeFileSync('generated.meta','generated');console.log('tail-control')`;
    const task: HostTask = { workspace, box: 'none', host_jobs: { test: { command: [process.execPath, '-e', code,
      '{entry}'], args: { entry: '[a-z]+' }, timeout_s: 30, lock: `host-test-${process.pid}`, output: 'tail' } } };
    assert.equal((await hostJob(task, runDir, 'missing')).status, 'failed');
    assert.equal((await hostJob(task, runDir, 'test', { entry: 'INVALID' })).status, 'failed');
    assert.equal((await hostJob(task, runDir, 'test', { entry: 'valid\n' })).status, 'failed');
    assert.equal((await hostJob(task, runDir, 'test', { entry: 'valid', extra: 'x' })).status, 'failed');
    const undeclared: HostTask = { ...task, host_jobs: { test: { ...task.host_jobs!.test, command: [process.execPath,
      '-e', code, '{missing}'] } } };
    assert.equal((await hostJob(undeclared, runDir, 'test', { entry: 'valid' })).status, 'failed');
    assert.equal(existsSync(marker), false);
    const first = await hostJob(task, runDir, 'test', { entry: 'valid' }, true);
    assert.equal(first.status, 'passed', JSON.stringify(first)); assert.match(first.tail.join('\n'), /tail-control/);
    // The first run made generated.meta, so it passed nothing about the files as they are now. The second run does.
    const second = await hostJob(task, runDir, 'test', { entry: 'valid' }, true);
    assert.equal(second.reused, undefined); assert.equal(readFileSync(marker, 'utf8'), 'xx');
    const third = await hostJob(task, runDir, 'test', { entry: 'valid' }, true);
    assert.equal(third.reused, true); assert.equal(readFileSync(marker, 'utf8'), 'xx');
    writeFileSync(path.join(workspace, 'file'), 'changed');
    const fourth = await hostJob(task, runDir, 'test', { entry: 'valid' }, true);
    assert.equal(fourth.status, 'passed'); assert.equal(fourth.reused, undefined);
    assert.equal(readFileSync(marker, 'utf8'), 'xxx');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two CLIs serialize the same lock while a different lock overlaps', { timeout: 120000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-queue-'));
  const agent = path.join(root, 'agent'); mkdirSync(agent);
  const marker = path.join(root, 'timing.jsonl'); const counters = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', part => body += part); req.on('end', () => {
      const match = /QUEUE_[ABC]/.exec(body); assert.ok(match); const key = match[0];
      const n = counters.get(key) ?? 0; counters.set(key, n + 1);
      const item = { type: 'function_call', id: `${key}i${n}`, call_id: `${key}c${n}`,
        name: n ? 'finish' : 'host_job', arguments: JSON.stringify(n ? { state: 'done', summary: 'done' } :
          { id: 'build' }), status: 'completed' };
      const response = { id: `${key}r${n}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dirs: string[] = [];
  try {
    const locks = path.resolve('runs/.locks'); mkdirSync(locks, { recursive: true });
    const staleName = createHash('sha256').update(`queue-${process.pid}-ab`).digest('hex');
    writeFileSync(path.join(locks, `${staleName}.lock`), JSON.stringify({ pid: 99999999,
      process_started_at: 0, run_dir: root, job: 'stale' }));
    const jobs = ['A', 'B', 'C'].map(key => {
      const workspace = path.join(root, key); mkdirSync(workspace);
      execFileSync('git', ['init', '-q', workspace]); writeFileSync(path.join(workspace, 'base'), key);
      execFileSync('git', ['-C', workspace, 'add', '.']);
      execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        'commit', '-qm', 'initial']);
      const code = `const f=require('fs'),p=${JSON.stringify(marker)},k=${JSON.stringify(key)};` +
        `f.appendFileSync(p,JSON.stringify([k,'start',Date.now()])+'\\n');` +
        `setTimeout(()=>f.appendFileSync(p,JSON.stringify([k,'end',Date.now()])+'\\n'),3500)`;
      const task = path.join(root, `${key}.json`);
      writeFileSync(task, JSON.stringify({ id: `queue-${key}-${process.pid}`, goal: `QUEUE_${key}`, workspace,
        model: 'gpt-6.1-terra', effort: 'medium', box: 'none', max_quota_percent: 10,
        base_url: `http://127.0.0.1:${address.port}/v1`, host_jobs: { build: {
          command: [process.execPath, '-e', code], timeout_s: 30, lock: `queue-${process.pid}-${key === 'C' ? 'c' : 'ab'}`,
          output: 'tail' } } }));
      const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', task], { env: { ...process.env,
        HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
      let output = ''; child.stdout.on('data', data => output += data);
      return new Promise<any>(resolve => child.on('close', () => resolve(JSON.parse(output))));
    });
    const results = await Promise.all(jobs); results.forEach(row => dirs.push(row.run_dir));
    for (const row of results) assert.equal(row.status, 'completed', JSON.stringify(row));
    const times: Record<string, Record<string, number>> = {};
    for (const line of readFileSync(marker, 'utf8').trim().split('\n')) {
      const [key, event, time] = JSON.parse(line); (times[key] ??= {})[event] = time;
    }
    assert.ok(times.A.end <= times.B.start || times.B.end <= times.A.start, JSON.stringify(times));
    assert.ok(times.C.start < Math.max(times.A.end, times.B.end) &&
      times.C.end > Math.min(times.A.start, times.B.start), JSON.stringify(times));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const dir of dirs) if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale locks and Unity lockfiles are handled, and summaries omit logs', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-unity-'));
  const workspace = path.join(root, 'work'); const runDir = path.join(root, 'run');
  const project = path.join(root, 'project'); mkdirSync(workspace); mkdirSync(runDir);
  mkdirSync(path.join(project, 'Temp'), { recursive: true });
  const unityLock = path.join(project, 'Temp', 'UnityLockfile'); writeFileSync(unityLock, 'lock');
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    execFileSync('git', ['init', '-q', workspace]); writeFileSync(path.join(workspace, 'base'), 'base');
    execFileSync('git', ['-C', workspace, 'add', '.']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'initial']);
    // The braces check that only declared placeholders are replaced: ordinary code in a command stays as it is.
    const code = `require('fs').writeFileSync(process.argv[1],JSON.stringify({ok:true}));` +
      `console.log('private-log-control')`;
    const task: HostTask = { workspace, box: 'none', host_queue_timeout_s: 15, host_jobs: { build: {
      command: [process.execPath, '-e', code, '{run_dir}\\host\\{job}.json'], timeout_s: 20,
      unity_project: project, output: 'summary', summary_file: '{run_dir}\\host\\{job}.json' } } };
    const locks = path.resolve('runs/.locks'); mkdirSync(locks, { recursive: true });
    const marker = path.join(locks, createHash('sha256').update(path.resolve(project).toLowerCase()).digest('hex') +
      '.lock');
    writeFileSync(marker, JSON.stringify({ pid: 99999999, process_started_at: 0, run_dir: runDir, job: 'old' }));
    const first = await hostJob(task, runDir, 'build');
    assert.equal(first.status, 'passed', JSON.stringify(first)); assert.deepEqual(first.summary, { ok: true });
    assert.doesNotMatch(JSON.stringify(first), /private-log-control/);
    const ps = `$f=[IO.File]::Open($env:HOST_TEST_LOCK,'Open','ReadWrite','None');` +
      `Write-Output ready; Start-Sleep -Seconds 3; $f.Dispose()`;
    holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { env: { ...process.env, HOST_TEST_LOCK: unityLock } });
    await new Promise<void>((resolve, reject) => {
      holder!.stdout!.once('data', () => resolve()); holder!.once('error', reject);
      holder!.once('close', code => reject(new Error(`lock holder exited: ${code}`)));
    });
    const started = Date.now(); task.host_queue_timeout_s = 1;
    assert.equal((await hostJob(task, runDir, 'build')).status, 'busy');
    task.host_queue_timeout_s = 15; const second = await hostJob(task, runDir, 'build');
    assert.equal(second.status, 'passed', JSON.stringify(second)); assert.ok(Date.now() - started >= 2500);
    const freeStart = Date.now(); const third = await hostJob(task, runDir, 'build');
    assert.equal(third.status, 'passed'); assert.ok(Date.now() - freeStart < 5000);
  } finally { holder?.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('summary hides logs from model requests while tail includes them', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-output-'));
  const workspace = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(workspace); mkdirSync(agent); writeFileSync(path.join(workspace, 'base'), 'base');
  execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'initial']);
  let requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', data => body += data); req.on('end', () => {
      requests.push(body); const first = requests.length === 1;
      const item = { type: 'function_call', id: `i${requests.length}`, call_id: `c${requests.length}`,
        name: first ? 'host_job' : 'finish', arguments: JSON.stringify(first ? { id: 'build' } :
          { state: 'done', summary: 'done' }), status: 'completed' };
      const response = { id: `r${requests.length}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dirs: string[] = [];
  try {
    for (const output of ['summary', 'tail']) {
      requests = [];
      const file = path.join(root, 'task.json');
      const code = `require('fs').writeFileSync(process.argv[1],'42');console.log('host-log-marker')`;
      writeFileSync(file, JSON.stringify({ id: `output-${output}`, goal: 'run the job', workspace, box: 'none',
        model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10,
        base_url: `http://127.0.0.1:${address.port}/v1`, host_jobs: { build: {
          command: [process.execPath, '-e', code, '{run_dir}\\host\\{job}.json'], timeout_s: 30,
          lock: `output-${process.pid}`, output, summary_file: '{run_dir}\\host\\{job}.json' } } }));
      const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { env: { ...process.env,
        HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
      let stdout = ''; child.stdout.on('data', data => stdout += data);
      await new Promise(resolve => child.on('close', resolve));
      const value = JSON.parse(stdout); dirs.push(value.run_dir); assert.equal(value.status, 'completed');
      assert.equal(requests[1].includes('host-log-marker'), output === 'tail');
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const dir of dirs) if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

for (const cleanup of ['resume', 'reclaim']) test(`${cleanup} reaps a host job left by a killed CLI`,
  { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-reap-'));
  const workspace = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(workspace); mkdirSync(agent); writeFileSync(path.join(workspace, 'base'), 'base');
  execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'initial']);
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      const first = calls++ === 0;
      const item = { type: 'function_call', id: `i${calls}`, call_id: `c${calls}`,
        name: first ? 'host_job' : 'finish', arguments: JSON.stringify(first ? { id: 'build' } :
          { state: 'done', summary: 'done' }), status: 'completed' };
      const response = { id: `r${calls}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const id = `host-reap-${process.pid}`; const heartbeat = path.join(root, 'heartbeat');
  let runDir = ''; let child: ReturnType<typeof spawn> | undefined;
  try {
    const file = path.join(root, 'task.json');
    const code = `setInterval(()=>require('fs').appendFileSync(process.argv[1],'x'),100)`;
    writeFileSync(file, JSON.stringify({ id, goal: 'run the job', workspace, box: 'none',
      model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10,
      base_url: `http://127.0.0.1:${address.port}/v1`, host_jobs: { build: {
        command: [process.execPath, '-e', code, heartbeat], timeout_s: 60, lock: id, output: 'tail' } } }));
    const env = { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' };
    child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { env });
    const limit = Date.now() + 30000;
    while (!existsSync(heartbeat) || readFileSync(heartbeat).length < 5) {
      if (Date.now() > limit) throw new Error('job did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const name = readdirSync(path.resolve('runs')).find(entry => entry.startsWith(id + '-')); assert.ok(name);
    runDir = path.resolve('runs', name); child.kill();
    await new Promise(resolve => child!.on('close', resolve)); child = undefined;
    if (cleanup === 'reclaim') {
      const otherRun = path.join(root, 'other-run'); mkdirSync(otherRun);
      const other: HostTask = { workspace, box: 'none', host_jobs: { build: { command: [process.execPath, '-e',
        "console.log('replacement started')"], timeout_s: 20, lock: id, output: 'tail' } } };
      const replacement = await hostJob(other, otherRun, 'build');
      assert.equal(replacement.status, 'passed', JSON.stringify(replacement));
      const afterReplacement = readFileSync(heartbeat).length;
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(readFileSync(heartbeat).length, afterReplacement);
    }
    const resume = spawn(process.execPath, [path.resolve('src/cli.ts'), 'resume', runDir], { env });
    let output = ''; resume.stdout.on('data', data => output += data);
    await new Promise(resolve => resume.on('close', resolve));
    assert.equal(JSON.parse(output).status, 'completed', output);
    const count = readFileSync(heartbeat).length;
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(readFileSync(heartbeat).length, count);
  } finally {
    child?.kill(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) { reap(runDir); rmSync(runDir, { recursive: true, force: true }); }
    rmSync(root, { recursive: true, force: true });
  }
});

test('finish reuses a passed host job across acceptance retries', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-accept-'));
  const workspace = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(workspace); mkdirSync(agent); writeFileSync(path.join(workspace, 'base'), 'base');
  execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'initial']);
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      const first = calls++ === 0;
      const item = { type: 'function_call', id: `i${calls}`, call_id: `c${calls}`,
        name: first ? 'host_job' : 'finish', arguments: JSON.stringify(first ? { id: 'build' } :
          { state: 'done', summary: 'done' }), status: 'completed' };
      const response = { id: `r${calls}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let runDir = '';
  try {
    const count = path.join(root, 'count'); const flag = path.join(root, 'flag');
    const code = `require('fs').appendFileSync(process.argv[1],'x');` +
      `require('fs').writeFileSync('generated.meta','generated')`;
    const flaky = `if (Test-Path -LiteralPath '${flag}') { exit 0 }; ` +
      `[IO.File]::WriteAllText('${flag}','done'); exit 1`;
    const file = path.join(root, 'task.json');
    writeFileSync(file, JSON.stringify({ id: `accept-${process.pid}`, goal: 'run the job', workspace, box: 'none',
      model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10,
      base_url: `http://127.0.0.1:${address.port}/v1`, host_jobs: { build: {
        command: [process.execPath, '-e', code, count], timeout_s: 30, lock: `accept-${process.pid}`,
        output: 'tail' } }, acceptance: [{ id: 'build-check', host_job: 'build' },
        { id: 'retry-check', command: flaky, timeout_s: 10 }] }));
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { env: { ...process.env,
      HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
    let stdout = ''; child.stdout.on('data', data => stdout += data);
    await new Promise(resolve => child.on('close', resolve));
    const value = JSON.parse(stdout); runDir = value.run_dir;
    assert.equal(value.status, 'completed', stdout); assert.equal(value.checks[0].reused, true);
    // The worker's own call made generated.meta, the first finish ran it on the files as they are, the second reused.
    assert.equal(readFileSync(count, 'utf8'), 'xx'); assert.equal(calls, 3);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
