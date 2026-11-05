import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runPowerShell } from '../src/box.ts';

test('an unreadable state returns a failed result and a reason', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-bad-state-'));
  try {
    const workspace = path.join(root, 'work'); const run = path.join(root, 'run');
    mkdirSync(workspace); mkdirSync(run);
    writeFileSync(path.join(run, 'task.json'), JSON.stringify({ id: 'bad-state', goal: 'test', workspace,
      model: 'gpt-6.1-terra', effort: 'medium' }));
    writeFileSync(path.join(run, 'state.json'), '{');
    const output = execFileSync(process.execPath, [path.resolve('src/cli.ts'), 'resume', run], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.status, 'failed'); assert.match(result.reason, /JSON|position|end/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PowerShell scripts preserve exit status and support long commands', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-stage5-'));
  const workspace = path.join(root, 'work');
  const scratch = path.join(root, 'scratch');
  mkdirSync(workspace);
  try {
    const run = async (script: string) => {
      const logPath = path.join(root, 'log');
      const result = await runPowerShell({ workspace, scratch, logPath, timeoutMs: 30000 }, script);
      return { ...result, text: readFileSync(logPath, 'utf8') };
    };
    const long = await run("Write-Output 'long-control'\n# " + 'x'.repeat(40000));
    assert.equal(long.exitCode, 0, JSON.stringify(long));
    assert.match(long.text, /long-control/);
    assert.equal((await run('exit 3')).exitCode, 3);
    for (const script of ['cmd /c exit 5', "throw 'x'", 'if (']) {
      const result = await run(script);
      assert.equal(result.status, 'exited', JSON.stringify(result));
      assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    }
    const priority = await run('(Get-Process -Id $PID).PriorityClass');
    assert.equal(priority.exitCode, 0, JSON.stringify(priority));
    assert.match(priority.text, /BelowNormal/i);
    const japanese = await run("Write-Output '\u65e5\u672c\u8a9e'");
    assert.match(japanese.text, /\u65e5\u672c\u8a9e/);
    const running = run("Write-Output 'started'; Start-Sleep -Seconds 4\n# " + 'x'.repeat(40000));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const query = 'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ' +
      '$_.CommandLine -and $_.CommandLine.IndexOf($env:HARNESS_TEST_RUN_DIR,' +
      '[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object CommandLine | ConvertTo-Json -Compress';
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
      { encoding: 'utf8', env: { ...process.env, HARNESS_TEST_RUN_DIR: scratch } });
    const parsed = JSON.parse(output); const items = Array.isArray(parsed) ? parsed : [parsed];
    const lines: string[] = items.map((item: { CommandLine: string }) => item.CommandLine);
    assert.ok(lines.some(line => line.includes('launch.mjs')), JSON.stringify(lines));
    assert.ok(lines.some(line => /powershell\.exe/i.test(line) && line.includes('ReadAllText')), JSON.stringify(lines));
    for (const line of lines.filter(line => line.includes('launch.mjs') || /powershell\.exe/i.test(line))) {
      assert.ok(line.length < 1000, `${line.length}: ${line}`);
    }
    assert.equal((await running).exitCode, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stop cancels a running CLI without stopping another run, then resume completes',
  { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-stop-'));
  const agent = path.join(root, 'agent'); mkdirSync(agent);
  const works = [path.join(root, 'a'), path.join(root, 'b')];
  const counts = [0, 0]; const dirs: string[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', part => body += part); req.on('end', () => {
      const match = /STOP_([01])/.exec(body); assert.ok(match);
      const i = Number(match[1]); const n = counts[i]++;
      const name = n === 0 ? 'run' : 'finish';
      const args = n === 0 ? { timeout_s: 60, command: "while ($true) { " +
        "Add-Content (Join-Path $env:HOME 'heartbeat.txt') 'tick'; Start-Sleep -Milliseconds 150 }" }
        : { state: 'done', summary: 'done' };
      const item = { type: 'function_call', id: `i${i}_${n}`, call_id: `c${i}_${n}`, name,
        arguments: JSON.stringify(args), status: 'completed' };
      const response = { id: `r${i}_${n}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  const waitFor = async (check: () => boolean) => {
    const end = Date.now() + 40000;
    while (!check()) {
      if (Date.now() > end) throw new Error('Timed out waiting for heartbeat');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const launch = (args: string[]) => {
      const child = spawn(process.execPath, [path.resolve('src/cli.ts'), ...args], { env: { ...process.env,
        HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
      children.push(child); let stdout = ''; let stderr = '';
      child.stdout!.on('data', c => stdout += c); child.stderr!.on('data', c => stderr += c);
      const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve =>
        child.on('close', code => resolve({ code, stdout, stderr })));
      return { child, done };
    };
    for (let i = 0; i < 2; i++) {
      mkdirSync(works[i]);
      const file = path.join(root, `task${i}.json`);
      writeFileSync(file, JSON.stringify({ id: `stop-${process.pid}-${i}`, goal: `STOP_${i}`,
        workspace: works[i], model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 1,
        base_url: `http://127.0.0.1:${address.port}/v1` }));
      launch(['run', file]);
    }
    const runRoot = path.resolve('runs');
    await waitFor(() => works.every((_, i) => readdirSync(runRoot).some(n => n.startsWith(`stop-${process.pid}-${i}-`))));
    for (let i = 0; i < 2; i++) dirs.push(path.join(runRoot,
      readdirSync(runRoot).find(n => n.startsWith(`stop-${process.pid}-${i}-`))!));
    const beats = dirs.map(dir => path.join(dir, 'scratch', 'heartbeat.txt'));
    await waitFor(() => beats.every(file => existsSync(file) && readFileSync(file, 'utf8').length > 10));
    const status = await launch(['status', dirs[0], dirs[1]]).done;
    assert.equal(status.code, 0, status.stderr);
    const rows = status.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.state), ['running', 'running']);
    const active = await launch(['status', '--active']).done;
    const activeRows = active.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(dirs.every(dir => activeRows.some(row => row.run_dir === dir && row.state === 'running')));
    const bad = path.join(root, 'bad'); mkdirSync(bad);
    const mixed = await launch(['status', bad, dirs[0]]).done;
    const mixedRows = mixed.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(mixedRows[0].error); assert.equal(mixedRows[1].state, 'running');
    // A run that fails during setup leaves only its result. It has ended, so it must not stay on the active list.
    const setupFailed = path.join(runRoot, `setup-failed-${process.pid}`); mkdirSync(setupFailed);
    writeFileSync(path.join(setupFailed, 'result.json'), JSON.stringify({ id: 'setup', status: 'failed', reason: 'early' }));
    try {
      const listed = (await launch(['status', '--active']).done).stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(listed.some(row => row.run_dir === setupFailed), false);
      const row = JSON.parse((await launch(['status', setupFailed]).done).stdout);
      assert.deepEqual([row.id, row.state, row.reason], ['setup', 'failed', 'early']);
    } finally { rmSync(setupFailed, { recursive: true, force: true }); }
    const duplicate = await launch(['resume', dirs[0]]).done;
    assert.equal(JSON.parse(duplicate.stdout).reason, 'already_running');
    assert.equal(existsSync(path.join(dirs[0], 'result.json')), false);
    // A shell whose own command line names the run folder must survive stop, or stop would end itself.
    const shell = spawn('cmd.exe', ['/d', '/s', '/c',
      `""${process.execPath}" "${path.resolve('src/cli.ts')}" stop "${dirs[0]}""`],
      { windowsVerbatimArguments: true, env: { ...process.env, HARNESS_AGENT_DIR: agent } });
    children.push(shell); let shellOutput = ''; shell.stdout!.on('data', c => shellOutput += c);
    assert.equal(await new Promise(resolve => shell.on('close', resolve)), 0);
    const stop = JSON.parse(shellOutput); assert.ok(stop.pids.length > 0, shellOutput);
    assert.equal(JSON.parse(readFileSync(path.join(dirs[0], 'result.json'), 'utf8')).status, 'cancelled');
    const cancelled = await launch(['status', dirs[0]]).done;
    assert.equal(JSON.parse(cancelled.stdout).state, 'cancelled');
    const a = readFileSync(beats[0], 'utf8').length; const b = readFileSync(beats[1], 'utf8').length;
    await waitFor(() => readFileSync(beats[1], 'utf8').length > b);
    assert.equal(readFileSync(beats[0], 'utf8').length, a);
    const resumed = await launch(['resume', dirs[0]]).done;
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, 'completed', resumed.stdout);
    const second = await launch(['stop', dirs[1]]).done;
    assert.equal(second.code, 0, second.stderr);
  } finally {
    for (const child of children) if (child.exitCode === null && child.pid) child.kill();
    for (const dir of dirs) if (existsSync(dir)) {
      try { execFileSync(process.execPath, [path.resolve('src/cli.ts'), 'stop', dir], { stdio: 'ignore' }); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('subscription failures stop or retry according to their code', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-retry-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(work); mkdirSync(agent);
  const cases = [
    [429, 'subscription_sharing_usage_limit_exceeded'],
    [403, 'subscription_sharing_user_not_eligible'],
    [400, 'subscription_sharing_unsupported_capability'],
    [403, 'subscription_sharing_route_not_supported'],
    [401, 'subscription_sharing_invalid_user'],
    [503, 'subscription_sharing_usage_unavailable'],
    [503, 'subscription_sharing_user_unavailable'],
    [200, 'subscription_sharing_usage_limit_exceeded'],
  ] as const;
  let index = 0; let requests = 0; let times: number[] = []; const dirs: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      requests++; times.push(Date.now());
      const [status, code] = cases[index];
      if (status === 200) {
        const item = { type: 'function_call', id: 'failed-item', call_id: 'failed-call', name: 'finish',
          arguments: JSON.stringify({ state: 'done', summary: 'should not succeed' }), status: 'completed' };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [{ type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.failed', response: { id: 'failed', status: 'failed', error: { code, message: code } } }];
        res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
        return;
      }
      if (status !== 503 || requests === 1) {
        res.writeHead(status, { 'content-type': 'application/json' });
        const message = status >= 400 && status < 429 ? `${code}: 503 retry` : code;
        res.end(JSON.stringify({ error: { code, message, type: code } })); return;
      }
      const item = { type: 'function_call', id: 'i1', call_id: 'c1', name: 'finish',
        arguments: JSON.stringify({ state: 'done', summary: 'done' }), status: 'completed' };
      const response = { id: 'r1', status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const task = path.join(root, 'task.json');
    for (index = 0; index < cases.length; index++) {
      requests = 0; times = [];
      writeFileSync(task, JSON.stringify({ id: `retry-${process.pid}-${index}`, goal: 'test',
        workspace: work, model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 1,
        base_url: `http://127.0.0.1:${address.port}/v1` }));
      const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', task], { env: { ...process.env,
        HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '', HARNESS_RETRY_BASE_MS: '50'
      } });
      let stdout = ''; let stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, stderr);
      const result = JSON.parse(stdout); if (result.run_dir) dirs.push(result.run_dir);
      assert.equal(requests, cases[index][0] === 503 ? 2 : 1, JSON.stringify(result));
      if (cases[index][0] === 503) assert.ok(times[1] - times[0] >= 45, JSON.stringify(times));
      if (index === 0 || cases[index][0] === 200) {
        assert.equal(result.status, 'budget_exhausted', stdout); assert.equal(result.reason, 'account_limit');
      }
      else if (index < 5) { assert.equal(result.status, 'failed'); assert.match(result.reason, /subscription_sharing/); }
      else assert.equal(result.status, 'completed', stdout);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('child role retries a transient response', { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-child-retry-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent');
  mkdirSync(work); mkdirSync(agent); let calls = 0; let runDir = '';
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      calls++;
      if (calls === 2) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'subscription_sharing_user_unavailable', message: 'unavailable' } }));
        return;
      }
      const name = calls === 1 ? 'delegate' : 'finish';
      const args = calls === 1 ? { role: 'worker', task: 'finish the assigned work' }
        : { state: 'done', summary: 'done' };
      const item = { type: 'function_call', id: `i${calls}`, call_id: `c${calls}`, name,
        arguments: JSON.stringify(args), status: 'completed' };
      const response = { id: `r${calls}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const file = path.join(root, 'task.json');
    writeFileSync(file, JSON.stringify({ id: 'child-retry', goal: 'delegate the task', workspace: work,
      model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 1,
      base_url: `http://127.0.0.1:${address.port}/v1`, roles: { worker: { model: 'gpt-6.1-terra',
        effort: 'medium', max_quota_percent: 1, tools: ['finish'] } } }));
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), 'run', file], { env: { ...process.env,
      HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '', HARNESS_RETRY_BASE_MS: '50'
    } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, stderr);
    const result = JSON.parse(stdout); runDir = result.run_dir;
    assert.equal(result.status, 'completed', stdout); assert.equal(calls, 4);
    assert.equal(result.usage.by_role.worker.calls, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('six CLI processes recover one interrupted run', { timeout: 180000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-six-'));
  const agent = path.join(root, 'agent'); mkdirSync(agent);
  const works = Array.from({ length: 6 }, (_, i) => path.join(root, `work${i}`));
  const counts = Array(6).fill(0); const durations: number[] = [];
  let resumedRequestValid = false;
  const children: ReturnType<typeof spawn>[] = []; const dirs: string[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', part => body += part); req.on('end', () => {
      const match = /JOB_([0-5])/.exec(body); assert.ok(match, body);
      const i = Number(match[1]); const n = counts[i]++;
      if (i === 0 && n >= 3) {
        const input = JSON.parse(body).input;
        const calls = input.filter((item: { type?: string }) => item.type === 'function_call');
        const outputs = input.filter((item: { type?: string }) => item.type === 'function_call_output');
        resumedRequestValid = calls.length >= 3 && calls.every((call: { call_id: string }) =>
          outputs.some((output: { call_id: string }) => output.call_id === call.call_id));
      }
      let name = 'finish'; let args: object = { state: 'done', summary: 'done' };
      if (n === 0) { name = 'inspect'; args = { reads: [{ path: 'control.txt' }] }; }
      if (n === 1) { name = 'edit'; args = { path: `own${i}.txt`, content: `edited-${i}\n` }; }
      if (n === 2) {
        name = 'run';
        const neighbor = path.join(works[(i + 1) % 6], 'control.txt').replaceAll("'", "''");
        const heartbeat = i === 0 ? "while ($true) { Add-Content (Join-Path $env:HOME 'heartbeat.txt') 'tick'; " +
          'Start-Sleep -Milliseconds 150 }'
          : '';
        args = { timeout_s: 90, command: `Write-Output 'own-control-${i}'; ` +
          `$x = Get-Content -LiteralPath '${neighbor}' -ErrorAction SilentlyContinue; ` +
          `if ($x) { Write-Output $x } else { Write-Output 'isolated' }; ${heartbeat}` };
      }
      const item = { type: 'function_call', id: `i${i}_${n}`, call_id: `c${i}_${n}`, name,
        arguments: JSON.stringify(args), status: 'completed' };
      const response = { id: `r${i}_${n}`, status: 'completed', output: [item],
        usage: { input_tokens: 30, output_tokens: 5 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  const waitFor = async (predicate: () => boolean, limit = 60000) => {
    const end = Date.now() + limit;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('Timed out waiting for test condition');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const start = Date.now();
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    for (let i = 0; i < 6; i++) {
      mkdirSync(works[i]); writeFileSync(path.join(works[i], 'control.txt'), `secret-${i}`);
      execFileSync('git', ['init', '-q', works[i]]);
      execFileSync('git', ['-C', works[i], 'add', '.']);
      execFileSync('git', ['-C', works[i], '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        'commit', '-qm', 'initial']);
      const file = path.join(root, `task${i}.json`);
      writeFileSync(file, JSON.stringify({ id: `stage5-${process.pid}-${i}`, goal: `JOB_${i}`,
        workspace: works[i], model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 1,
        base_url: `http://127.0.0.1:${address.port}/v1`,
        acceptance: [{ id: 'exists', command: `if (!(Test-Path own${i}.txt)) { exit 1 }`, timeout_s: 30 }] }));
    }
    const launch = (args: string[]) => {
      const child = spawn(process.execPath, [path.resolve('src/cli.ts'), ...args], { env: { ...process.env,
        HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
      children.push(child); let output = ''; let error = '';
      child.stdout!.on('data', c => output += c); child.stderr!.on('data', c => error += c);
      const result = new Promise<any>(resolve => child.on('close', code => resolve({ code, output, error })));
      return { child, result };
    };
    const runs = works.map((_, i) => launch(['run', path.join(root, `task${i}.json`)]));
    const runRoot = path.resolve('runs');
    await waitFor(() => works.every((_, i) => readdirSync(runRoot).some(n => n.startsWith(`stage5-${process.pid}-${i}-`))));
    for (let i = 0; i < 6; i++) dirs.push(path.join(runRoot,
      readdirSync(runRoot).find(n => n.startsWith(`stage5-${process.pid}-${i}-`))!));
    const beat = path.join(dirs[0], 'scratch', 'heartbeat.txt');
    await waitFor(() => existsSync(beat) && readFileSync(beat, 'utf8').length > 10);
    runs[0].child.kill(); await runs[0].result;
    const before = readFileSync(beat, 'utf8').length;
    await waitFor(() => readFileSync(beat, 'utf8').length > before);
    const interrupted = await launch(['status', dirs[0]]).result;
    assert.equal(interrupted.code, 0, interrupted.error);
    assert.equal(JSON.parse(interrupted.output).state, 'interrupted');
    for (let i = 1; i < 6; i++) {
      const result = await runs[i].result; assert.equal(result.code, 0, result.error);
      const value = JSON.parse(result.output); assert.equal(value.status, 'completed', result.output);
      assert.deepEqual(value.diff.files, [`own${i}.txt`]);
    }
    const sessionDir = path.join(dirs[0], 'session');
    const sessionFile = path.join(sessionDir, readdirSync(sessionDir).find(n => n.endsWith('.jsonl'))!);
    const completeLines = readFileSync(sessionFile, 'utf8');
    assert.ok(completeLines.endsWith('\n'));
    appendFileSync(sessionFile, '{"truncated":');
    // Status must read a torn ledger, and resume must leave it whole for later appends.
    const ledgerFile = path.join(dirs[0], 'ledger.jsonl');
    appendFileSync(ledgerFile, '{"torn":\0\0\0');
    const torn = await launch(['status', dirs[0]]).result;
    assert.equal(JSON.parse(torn.output).state, 'interrupted', torn.output);
    const resumed = await launch(['resume', dirs[0]]).result;
    assert.equal(resumed.code, 0, resumed.error);
    const resumedValue = JSON.parse(resumed.output);
    assert.equal(resumedValue.status, 'completed', resumed.output);
    assert.ok(resumedRequestValid, 'resumed request must pair every tool call with an output');
    assert.deepEqual(resumedValue.diff.files, ['own0.txt']);
    assert.ok(readFileSync(sessionFile, 'utf8').startsWith(completeLines));
    for (const line of readFileSync(ledgerFile, 'utf8').trim().split('\n')) JSON.parse(line);
    const stopped = readFileSync(beat, 'utf8').length;
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(readFileSync(beat, 'utf8').length, stopped);
    for (let i = 0; i < 6; i++) {
      const logs = path.join(dirs[i], 'logs');
      const text = readdirSync(logs).filter(n => n.endsWith('.log')).map(n => readFileSync(path.join(logs, n), 'utf8'))
        .join('\n');
      assert.match(text, new RegExp(`own-control-${i}`)); assert.match(text, /isolated/);
      assert.doesNotMatch(text, new RegExp(`secret-${(i + 1) % 6}`));
      const query = 'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ' +
        '$_.CommandLine -and $_.CommandLine.IndexOf($env:HARNESS_TEST_RUN_DIR,' +
        '[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -ExpandProperty ProcessId';
      const remaining = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
        { encoding: 'utf8', env: { ...process.env, HARNESS_TEST_RUN_DIR: dirs[i] } });
      assert.equal(remaining.trim(), '', `remaining processes for ${dirs[i]}: ${remaining}`);
      const sessionDir = path.join(dirs[i], 'session');
      for (const name of readdirSync(sessionDir).filter(name => name.endsWith('.jsonl'))) {
        for (const line of readFileSync(path.join(sessionDir, name), 'utf8').split('\n').filter(Boolean)) {
          const entry = JSON.parse(line);
          if (entry.message?.role === 'toolResult' && entry.message.toolName !== 'finish' &&
            typeof entry.message.durationMs === 'number') durations.push(entry.message.durationMs);
        }
      }
    }
    assert.ok(durations.length >= 17);
    durations.sort((a, b) => a - b);
    console.log(`six runs elapsed=${Date.now() - start}ms tool median=${durations[Math.floor(durations.length / 2)]}ms`);
  } finally {
    for (const child of children) if (child.exitCode === null && child.pid) child.kill();
    for (const dir of dirs) if (existsSync(dir)) {
      try { execFileSync(process.execPath, [path.resolve('src/cli.ts'), 'stop', dir], { stdio: 'ignore' }); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
