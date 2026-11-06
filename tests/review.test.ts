// Each test here reproduces something an independent review of the harness found. The worker is not trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { onPath } from '../src/boxed/which.mjs';
import { hostJob, type HostTask } from '../src/host.ts';
import { installGate, GateBlocked } from '../src/gate.ts';
import { gitData, inspectDiff } from '../src/rules.ts';
import { specQuestions } from '../src/loop.ts';
import { readTerms, scanValue } from '../src/scan.ts';
import { runPowerShell } from '../src/box.ts';
import { activity, createTools } from '../src/tools.ts';
import { reap } from '../src/commands.ts';
import { audit, hash } from '../src/clean.ts';

const repository = (work: string) => {
  execFileSync('git', ['init', '-q', work]);
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm',
    'initial']);
};

// A scripted model server. `steps` lists the replies in order, then plain finish calls.
async function modelServer(steps: Array<{ tool: string; args: object } | 'hold'>) {
  const bodies: string[] = []; let held: http.ServerResponse | undefined; let onHold: (() => void) | undefined;
  const server = http.createServer((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk; }); req.on('end', () => {
      bodies.push(data);
      const step = steps[bodies.length - 1] ?? { tool: 'finish', args: { state: 'done', summary: 'done' } };
      if (step === 'hold') { held = res; onHold?.(); return; }
      const n = bodies.length;
      const item = { type: 'function_call', id: `i${n}`, call_id: `c${n}`, name: step.tool,
        arguments: JSON.stringify(step.args), status: 'completed' };
      const response = { id: `r${n}`, status: 'completed', output: [item], usage: { input_tokens: 30,
        output_tokens: 5 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { bodies, url: `http://127.0.0.1:${address.port}/v1`,
    waitForHold: () => new Promise<void>(resolve => { if (held) resolve(); else onHold = resolve; }),
    release: () => { held?.destroy(); held = undefined; },
    close: () => { held?.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

function cli(args: string[], agent: string) {
  const child = spawn(process.execPath, [path.resolve('src/cli.ts'), ...args], { env: { ...process.env,
    HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake', HARNESS_QUOTA_COMMAND: '' } });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
  const done = new Promise<any>(resolve => child.on('close', () => resolve(stdout ? JSON.parse(stdout) : null)));
  return { child, done };
}

test('programs start from PATH even with a copy planted in the current folder', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-path-'));
  try {
    copyFileSync(process.execPath, path.join(root, 'whoami.exe'));
    // Control: without onPath, and without the shell variable that hides it, Windows starts the planted copy.
    const shellVar = Object.keys(process.env).find(k => k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath');
    const clean = { ...process.env }; if (shellVar) delete clean[shellVar];
    const probe = `const r=require('child_process').spawnSync('whoami.exe',['-p','1+1'],{encoding:'utf8'});` +
      `console.log(r.stdout.trim())`;
    assert.equal(spawnSync(process.execPath, ['-e', probe], { cwd: root, env: clean, encoding: 'utf8' }).stdout.trim(),
      '2');
    const original = process.cwd();
    process.chdir(root);
    try {
      const found = onPath('whoami.exe');
      assert.ok(path.isAbsolute(found)); assert.notEqual(path.dirname(found).toLowerCase(), root.toLowerCase());
    } finally { process.chdir(original); }
    assert.throws(() => onPath('no-such-program-here'), /not found/);
    assert.throws(() => onPath('.\\whoami.exe'), /name or a full path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planted git and powershell cannot replace the checks or a host job', { timeout: 120000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-planted-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  writeFileSync(path.join(work, 'base.txt'), 'base');
  repository(work);
  const code = `require('fs').writeFileSync(process.argv[1],'ran')`;
  const stamp = path.join(root, 'stamp');
  const copyInto = (name: string) => `[IO.File]::Copy('${process.execPath}', '${path.join(work, name)}')`;
  const model = await modelServer([
    { tool: 'run', args: { timeout_s: 60, command: `${copyInto('git.exe')}; ${copyInto('powershell.exe')}; ` +
      `${copyInto('whoami.exe')}; Write-Output planted` } },
    { tool: 'host_job', args: { id: 'real' } },
  ]);
  const file = path.join(root, 'task.json');
  writeFileSync(file, JSON.stringify({ id: `planted-${process.pid}`, goal: 'plant', workspace: work,
    model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10, base_url: model.url,
    host_jobs: { real: { command: ['whoami.exe'], timeout_s: 30, lock: `planted-${process.pid}`, output: 'tail' },
      node: { command: [process.execPath, '-e', code, stamp], timeout_s: 30, lock: `planted2-${process.pid}`,
        output: 'tail' } },
    // A planted copy of node refuses these arguments, so a real exit 7 proves the real PowerShell ran.
    acceptance: [{ id: 'real-powershell', command: 'Write-Output real; exit 0', timeout_s: 60 },
      { id: 'node-job', host_job: 'node' }] }));
  let runDir = '';
  try {
    const result = await cli(['run', file], agent).done; runDir = result.run_dir;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    // The diff still came from the real git, so the planted programs are visible.
    assert.ok(result.diff.files.includes('git.exe')); assert.ok(result.diff.files.includes('powershell.exe'));
    assert.ok(existsSync(stamp));
    // whoami from PATH prints a user name, where the planted node copy would wait or fail.
    assert.match(model.bodies[2], /status\\+":\\+"passed/);
  } finally {
    await model.close();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a junction cannot make the harness read outside the workspace', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-link-'));
  const work = path.join(root, 'work'); const outside = path.join(root, 'outside'); const runDir = path.join(root, 'run');
  mkdirSync(work); mkdirSync(outside); mkdirSync(runDir);
  writeFileSync(path.join(outside, 'spec.md'), '## secret heading\n- item\n');
  writeFileSync(path.join(outside, 'result.json'), JSON.stringify({ secret: 'outside-marker' }));
  writeFileSync(path.join(work, 'spec.md'), '## inside heading\n- item\n');
  writeFileSync(path.join(work, '.gitignore'), 'report\n');
  repository(work);
  symlinkSync(outside, path.join(work, 'report'), 'junction');
  try {
    assert.match(specQuestions(work, 'spec.md')[0].id, /inside heading/);
    assert.throws(() => specQuestions(work, 'report/spec.md'), /outside the workspace/);
    const task: HostTask = { workspace: work, box: 'none', host_jobs: { job: { command: [process.execPath, '-e', '0'],
      timeout_s: 30, lock: `link-${process.pid}`, output: 'summary', summary_file: '{workspace}/report/result.json' } } };
    const linked = await hostJob(task, runDir, 'job');
    assert.deepEqual(linked.summary, { error: 'unreadable' });
    // Control: the same read works for a real file.
    writeFileSync(path.join(runDir, 'real.json'), JSON.stringify({ ok: true }));
    task.host_jobs!.job.summary_file = '{run_dir}/real.json';
    assert.deepEqual((await hostJob(task, runDir, 'job')).summary, { ok: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one workspace has one writer, and it is free again after the first ends', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-busy-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  writeFileSync(path.join(work, 'base.txt'), 'base'); repository(work);
  const model = await modelServer(['hold']);
  const file = path.join(root, 'task.json');
  writeFileSync(file, JSON.stringify({ id: `busy-${process.pid}`, goal: 'hold', workspace: work,
    model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10, base_url: model.url }));
  const dirs: string[] = [];
  try {
    const first = cli(['run', file], agent);
    await model.waitForHold();
    const second = await cli(['run', file], agent).done;
    assert.equal(second.status, 'failed'); assert.equal(second.reason, 'workspace_busy');
    assert.equal(second.run_dir, null); assert.equal(model.bodies.length, 1);
    model.release();
    const ended = await first.done; if (ended?.run_dir) dirs.push(ended.run_dir);
    const third = await cli(['run', file], agent).done; if (third.run_dir) dirs.push(third.run_dir);
    assert.notEqual(third.reason, 'workspace_busy');
  } finally {
    await model.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a CLI killed before its first reply was saved still sends the goal on resume', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-goal-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  writeFileSync(path.join(work, 'base.txt'), 'base'); repository(work);
  const model = await modelServer(['hold']);
  const file = path.join(root, 'task.json'); const id = `goal-${process.pid}`;
  writeFileSync(file, JSON.stringify({ id, goal: 'the-original-goal-marker', workspace: work,
    model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10, base_url: model.url }));
  let runDir = '';
  try {
    const first = cli(['run', file], agent);
    await model.waitForHold();
    first.child.kill(); await first.done;
    const runs = path.resolve('runs');
    runDir = path.join(runs, readdirSync(runs).find(name => name.startsWith(`${id}-`))!);
    const resumed = await cli(['resume', runDir], agent).done;
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
    assert.match(model.bodies[1], /the-original-goal-marker/);
  } finally {
    await model.close();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pass does not outlive a change to an ignored file the job reads', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-ignored-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, '.gitignore'), 'config.json\n'); writeFileSync(path.join(work, 'config.json'), 'good');
  repository(work);
  const count = path.join(root, 'count');
  const code = `const f=require('fs');f.appendFileSync(process.argv[1],'x');` +
    `process.exit(f.readFileSync('config.json','utf8')==='good'?0:1)`;
  const task: HostTask = { workspace: work, box: 'none', host_jobs: { job: { command: [process.execPath, '-e', code,
    count], timeout_s: 30, lock: `ignored-${process.pid}`, output: 'tail' } } };
  try {
    assert.equal((await hostJob(task, runDir, 'job', {}, true)).status, 'passed');
    const again = await hostJob(task, runDir, 'job', {}, true);
    assert.equal(again.reused, true); assert.equal(readFileSync(count, 'utf8'), 'x');
    writeFileSync(path.join(work, 'config.json'), 'changed-to-bad');
    const changed = await hostJob(task, runDir, 'job', {}, true);
    assert.equal(changed.reused, undefined); assert.equal(changed.status, 'failed');
    assert.equal(readFileSync(count, 'utf8'), 'xx');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('calling a text file binary in .gitattributes does not hide its lines', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-attr-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'a.ts'), 'const a = 1;\n');
  writeFileSync(path.join(work, 'data.bin'), Buffer.from([0, 1, 2, 0]));
  repository(work);
  const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(work, '.gitattributes'), '*.ts -diff\n');
  writeFileSync(path.join(work, 'a.ts'), 'const a = 1;\n// @ts-ignore\nconst b = 2;\n');
  writeFileSync(path.join(work, 'data.bin'), Buffer.from([0, 9, 9, 0]));
  try {
    const inspected = inspectDiff(await gitData(work, runDir, 'diff', head), { max_added_lines: 100 });
    assert.ok(inspected.violations.some(item => item.id === 'suppression' && item.path === 'a.ts'),
      JSON.stringify(inspected));
    assert.ok(inspected.diff.added >= 2);
    assert.ok(inspected.diff.files.includes('data.bin'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('text inside an attached image is checked by its bytes', async () => {
  const terms = readTerms('forbidden-word-alpha\n');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('tEXtforbidden-word-alpha')]);
  const plain = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('tEXtsomething else')]);
  const url = (data: Buffer) => `data:image/png;base64,${data.toString('base64')}`;
  assert.deepEqual(scanValue(url(png), terms), [1]);
  assert.deepEqual(scanValue(url(plain), terms), []);
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-image-'));
  const original = globalThis.fetch; let received = 0;
  const termsFile = path.join(root, 'terms'); writeFileSync(termsFile, 'forbidden-word-alpha\n');
  globalThis.fetch = async () => { received++; return new Response('ok'); };
  const restore = installGate({ allowedHosts: ['localhost:1234'], model: 'test', effort: 'medium', tools: [],
    ledgerPath: path.join(root, 'ledger'), maxQuotaPercent: 1, forbiddenTermsFile: termsFile });
  const send = (data: Buffer) => fetch('http://localhost:1234/responses', { method: 'POST', body: JSON.stringify({
    model: 'test', reasoning: { effort: 'medium' }, input: [{ role: 'user', content: [{ type: 'input_image',
      image_url: url(data) }] }] }) });
  try {
    await assert.rejects(send(png), GateBlocked); assert.equal(received, 0);
    await send(plain); await restore.flush(); assert.equal(received, 1);
  } finally { restore(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('a .git file the worker made adds nothing to what the box can read', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-nogit-'));
  const work = path.join(root, 'work'); const scratch = path.join(root, 'scratch');
  const secret = path.join(root, 'outside'); mkdirSync(work); mkdirSync(secret);
  writeFileSync(path.join(secret, 'secret.txt'), 'outside-marker');
  const logPath = path.join(root, 'log');
  const options = { workspace: work, scratch, logPath, timeoutMs: 30000 };
  try {
    // The box lets this through because .git does not exist yet, so the guard has to be in what the harness trusts.
    const fake = path.join(scratch, 'fake');
    const script = `[void][IO.Directory]::CreateDirectory('${fake}')\n` +
      `[IO.File]::WriteAllText('${path.join(fake, 'commondir')}', '${secret}')\n` +
      `[IO.File]::WriteAllText('.git', 'gitdir: ${fake}')`;
    assert.equal((await runPowerShell(options, script)).exitCode, 0, readFileSync(logPath, 'utf8'));
    assert.equal(existsSync(path.join(work, '.git')), true);
    await assert.rejects(runPowerShell(options, `Get-Content '${path.join(secret, 'secret.txt')}'`),
      /Invalid git file/);
    // Control: a resumed run that saved a real .git file keeps working with it, and the trust is by content.
    rmSync(path.join(work, '.git'));
    assert.equal((await runPowerShell(options, 'Write-Output fine')).exitCode, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a pass is not reused once something that can change files has run', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-activity-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'base.txt'), 'base'); repository(work);
  const count = path.join(root, 'count');
  const task: HostTask = { workspace: work, box: 'none', host_jobs: { job: { command: [process.execPath, '-e',
    "require('fs').appendFileSync(process.argv[1],'x')", count], timeout_s: 30, lock: `activity-${process.pid}`,
    output: 'tail' } } };
  try {
    assert.equal((await hostJob(task, runDir, 'job', {}, true)).status, 'passed');
    assert.equal((await hostJob(task, runDir, 'job', {}, true)).reused, true);
    activity.count++;
    assert.equal((await hostJob(task, runDir, 'job', {}, true)).reused, undefined);
    assert.equal(readFileSync(count, 'utf8'), 'xx');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('acceptance checks that change files do not pass', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-checked-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  writeFileSync(path.join(work, 'value.txt'), 'ok\n'); repository(work);
  const model = await modelServer([]);
  const file = path.join(root, 'task.json');
  writeFileSync(file, JSON.stringify({ id: `checked-${process.pid}`, goal: 'finish', workspace: work,
    model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10, base_url: model.url, max_continues: 1,
    acceptance: [{ id: 'first', command: "if (Select-String -Path value.txt -Pattern 'ok' -Quiet) { exit 0 }; exit 1",
      timeout_s: 30 }, { id: 'rewrites', command: "[IO.File]::AppendAllText('value.txt', 'more`n'); exit 0",
      timeout_s: 30 }] }));
  let runDir = '';
  try {
    const result = await cli(['run', file], agent).done; runDir = result.run_dir;
    assert.equal(result.status, 'needs_judgment', JSON.stringify(result));
    assert.match(result.reason, /changed files/);
  } finally {
    await model.close();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a NUL byte or a line starting with ++ does not hide an added line', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-nul-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'a.js'), 'const a = 1;\n');
  writeFileSync(path.join(work, 'b.js'), 'let c = 0;\n');
  writeFileSync(path.join(work, 'picture.png'), Buffer.from([137, 80, 78, 71, 255, 0, 254, 0]));
  repository(work);
  const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(work, 'a.js'), 'const a = 1;\n/*\u0000*/\n// @ts-ignore\nconst b = 2;\n');
  writeFileSync(path.join(work, 'b.js'), 'let c = 0;\n++c; // TODO later\n');
  writeFileSync(path.join(work, 'picture.png'), Buffer.from([137, 80, 78, 71, 255, 0, 253, 0]));
  try {
    const inspected = inspectDiff(await gitData(work, runDir, 'diff', head));
    const has = (id: string, file: string) => inspected.violations.some(item => item.id === id && item.path === file);
    assert.ok(has('suppression', 'a.js'), JSON.stringify(inspected));
    assert.ok(has('leftover', 'b.js'), JSON.stringify(inspected));
    assert.equal(inspected.violations.filter(item => item.path === 'picture.png').length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean room sends no pictures', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-nopic-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'image.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const original = globalThis.fetch; let received = 0;
  globalThis.fetch = async () => { received++; return new Response('ok'); };
  const restore = installGate({ cleanRoom: true, allowedHosts: ['localhost:1234'], model: 'test', effort: 'medium',
    tools: [], ledgerPath: path.join(root, 'ledger'), maxQuotaPercent: 1 });
  const body = (url: string) => fetch('http://localhost:1234/responses', { method: 'POST', body: JSON.stringify({
    model: 'test', reasoning: { effort: 'medium' }, input: [{ role: 'user', content: [{ type: 'input_image',
      image_url: url }] }] }) });
  try {
    await assert.rejects(body('data:image/png;base64,AAAA'), GateBlocked); assert.equal(received, 0);
    await fetch('http://localhost:1234/responses', { method: 'POST', body: JSON.stringify({ model: 'test',
      reasoning: { effort: 'medium' }, input: 'plain text' }) });
    await restore.flush(); assert.equal(received, 1);
    const tool = createTools({ workspace: work, runDir, box: 'none', readRoots: [], noImages: true, finish: () => {} })
      .find(item => item.name === 'inspect'); assert.ok(tool);
    const value = await tool.execute('test', { images: ['image.png'] } as never, undefined, undefined, {} as never);
    assert.match((value.content[0] as { text: string }).text, /images_not_allowed/);
    assert.equal(value.content.length, 1);
  } finally { restore(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('a junction in place of scratch or the workspace gives no new write access', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-swap-'));
  const work = path.join(root, 'work'); const scratch = path.join(root, 'scratch');
  const target = path.join(root, 'target'); mkdirSync(work); mkdirSync(scratch); mkdirSync(target);
  const logPath = path.join(root, 'log');
  const options = { workspace: work, scratch, logPath, timeoutMs: 30000 };
  try {
    assert.equal((await runPowerShell(options, 'Write-Output fine')).exitCode, 0);
    rmSync(scratch, { recursive: true }); symlinkSync(target, scratch, 'junction');
    await assert.rejects(runPowerShell(options, 'Write-Output swapped'), /Scratch is a link/);
    assert.deepEqual(readdirSync(target), []);
    rmSync(scratch); mkdirSync(scratch);
    rmSync(work, { recursive: true }); symlinkSync(target, work, 'junction');
    await assert.rejects(runPowerShell(options, 'Write-Output swapped'), /Workspace or read root moved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reap leaves another run that only names this scratch as an argument', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-reap-'));
  const run = path.join(root, 'run'); const scratch = path.join(run, 'scratch'); mkdirSync(scratch, { recursive: true });
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', path.join(scratch, 'input.json')],
    { stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(reap(run), []);
    assert.equal(other.exitCode, null);
    assert.doesNotThrow(() => process.kill(other.pid!, 0));
  } finally { other.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('a pass does not cover files the job itself changed', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-after-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'config.txt'), 'good'); repository(work);
  const code = "const f=require('fs');if(f.readFileSync('config.txt','utf8')!=='good')process.exit(1);" +
    "f.writeFileSync('config.txt','bad')";
  const task: HostTask = { workspace: work, box: 'none', host_jobs: { job: { command: [process.execPath, '-e', code],
    timeout_s: 30, lock: `after-${process.pid}`, output: 'tail' } } };
  try {
    assert.equal((await hostJob(task, runDir, 'job', {}, true)).status, 'passed');
    const finish = await hostJob(task, runDir, 'job', {}, true);
    assert.equal(finish.reused, undefined); assert.equal(finish.status, 'failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new source file with a NUL byte still has its lines checked', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-newnul-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'base.txt'), 'base\n'); repository(work);
  const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(work, 'new.ts'), '// @ts-nocheck\nexport const x = 1;\n//\u0000\n');
  writeFileSync(path.join(work, 'new.png'), Buffer.from([137, 80, 78, 71, 255, 0]));
  try {
    const inspected = inspectDiff(await gitData(work, runDir, 'diff', head), { max_added_lines: 100 });
    assert.ok(inspected.violations.some(item => item.id === 'suppression' && item.path === 'new.ts'));
    assert.ok(inspected.diff.added >= 3);
    assert.ok(!inspected.violations.some(item => item.path === 'new.png'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without git, a check that changes files still does not pass', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-nogit-check-'));
  const work = path.join(root, 'work'); const agent = path.join(root, 'agent'); mkdirSync(work); mkdirSync(agent);
  writeFileSync(path.join(work, 'value.txt'), 'ok\n');
  const model = await modelServer([]);
  const file = path.join(root, 'task.json');
  writeFileSync(file, JSON.stringify({ id: `nogit-${process.pid}`, goal: 'finish', workspace: work,
    model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10, base_url: model.url, max_continues: 1,
    acceptance: [{ id: 'rewrites', command: "[IO.File]::AppendAllText('value.txt', 'more`n'); exit 0",
      timeout_s: 30 }] }));
  let runDir = '';
  try {
    const result = await cli(['run', file], agent).done; runDir = result.run_dir;
    assert.equal(result.status, 'needs_judgment', JSON.stringify(result));
    assert.match(result.reason, /changed files/);
  } finally {
    await model.close();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a term in the header of a data string and a gap in the copies are both found', async () => {
  const terms = readTerms('forbidden-word-alpha\n');
  assert.deepEqual(scanValue('data:text/forbidden-word-alpha;base64,QQ==', terms), [1]);
  assert.deepEqual(scanValue('data:;base64,forbidden-word-alpha', terms), [1]);
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-gap-'));
  const original = globalThis.fetch; globalThis.fetch = async () => new Response('ok');
  const termsFile = path.join(root, 'terms'); writeFileSync(termsFile, 'forbidden-word-alpha\n');
  writeFileSync(path.join(root, 'task.json'), JSON.stringify({ clean_room: {}, forbidden_terms_file: termsFile,
    read_roots: [], box: 'mxc' }));
  const ledger = path.join(root, 'ledger.jsonl');
  writeFileSync(ledger, JSON.stringify({ clean_room: { manifest_sha256: 'test',
    terms_file_sha256: hash(readFileSync(termsFile)) } }) + '\n');
  const restore = installGate({ cleanRoom: true, allowedHosts: ['localhost:1234'], model: 'test', effort: 'medium',
    tools: [], ledgerPath: ledger, maxQuotaPercent: 1 });
  try {
    for (let i = 0; i < 3; i++) await fetch('http://localhost:1234/responses', { method: 'POST', body: JSON.stringify({
      model: 'test', reasoning: { effort: 'medium' }, input: `request ${i}` }) });
    await restore.flush();
    assert.equal(audit(root).ok, true);
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(line => !line.includes('"request_number":2'));
    writeFileSync(ledger, lines.join('\n')); rmSync(path.join(root, 'requests', '2.json.gz'));
    const after = audit(root);
    assert.equal(after.ok, false); assert.ok(after.mismatch.some(item => item.startsWith('gap')));
  } finally { restore(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('a read root reached through a junction cannot be pointed somewhere else', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-readroot-'));
  const work = path.join(root, 'work'); const scratch = path.join(root, 'scratch');
  const shared = path.join(root, 'shared'); const other = path.join(root, 'other');
  mkdirSync(work); mkdirSync(shared); mkdirSync(other);
  writeFileSync(path.join(shared, 'allowed.txt'), 'allowed-marker');
  const link = path.join(work, 'deps'); symlinkSync(shared, link, 'junction');
  const logPath = path.join(root, 'log');
  const options = { workspace: work, scratch, logPath, timeoutMs: 30000, readRoots: [link] };
  try {
    assert.equal((await runPowerShell(options, `Get-Content '${path.join(shared, 'allowed.txt')}'`)).exitCode, 0);
    assert.match(readFileSync(logPath, 'utf8'), /allowed-marker/);
    rmSync(link); symlinkSync(other, link, 'junction');
    await assert.rejects(runPowerShell(options, 'Write-Output swapped'), /Workspace or read root moved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a folder and its subfolder cannot run at once', { timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-nested-'));
  const work = path.join(root, 'work'); const sub = path.join(work, 'sub'); const agent = path.join(root, 'agent');
  mkdirSync(sub, { recursive: true }); mkdirSync(agent);
  writeFileSync(path.join(work, '.gitignore'), 'sub/\n'); repository(work);
  writeFileSync(path.join(sub, 'a.txt'), 'a'); repository(sub);
  const model = await modelServer(['hold']);
  const task = (name: string, workspace: string) => {
    const file = path.join(root, `${name}.json`);
    writeFileSync(file, JSON.stringify({ id: `nested-${name}-${process.pid}`, goal: name, workspace,
      model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10, base_url: model.url }));
    return file;
  };
  const dirs: string[] = [];
  try {
    const first = cli(['run', task('parent', work)], agent);
    await model.waitForHold();
    const second = await cli(['run', task('child', sub)], agent).done;
    assert.equal(second.reason, 'workspace_busy', JSON.stringify(second)); assert.equal(model.bodies.length, 1);
    model.release();
    const ended = await first.done; if (ended?.run_dir) dirs.push(ended.run_dir);
    const third = await cli(['run', task('child', sub)], agent).done; if (third.run_dir) dirs.push(third.run_dir);
    assert.notEqual(third.reason, 'workspace_busy');
  } finally {
    await model.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('names with spaces keep their lines, and source too large to read is flagged', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-names-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  mkdirSync(path.join(work, 'My Folder'));
  writeFileSync(path.join(work, 'My Folder', 'a b.ts'), 'const a = 1;\n');
  writeFileSync(path.join(work, 'big.ts'), 'const a = 1;\n');
  repository(work);
  const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(work, 'My Folder', 'a b.ts'), 'const a = 1;\n// @ts-ignore\n');
  writeFileSync(path.join(work, '.gitattributes'), 'big.ts -diff\n');
  writeFileSync(path.join(work, 'big.ts'), '// @ts-nocheck\n' + 'x'.repeat(17 * 1024 * 1024) + '\n');
  try {
    const inspected = inspectDiff(await gitData(work, runDir, 'diff', head));
    const has = (id: string, file: string) => inspected.violations.some(item => item.id === id && item.path === file);
    assert.ok(has('suppression', 'My Folder/a b.ts'), JSON.stringify(inspected));
    assert.ok(has('too_large', 'big.ts'), JSON.stringify(inspected));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a repository made inside the workspace cannot hide files from the checks', { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-inner-'));
  const work = path.join(root, 'work'); const runDir = path.join(root, 'run'); mkdirSync(work); mkdirSync(runDir);
  writeFileSync(path.join(work, 'base.txt'), 'base\n'); repository(work);
  const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const inner = path.join(work, 'payload'); mkdirSync(inner);
  writeFileSync(path.join(inner, 'x.ts'), '// @ts-nocheck\n'); repository(inner);
  try {
    const inspected = inspectDiff(await gitData(work, runDir, 'diff', head));
    assert.ok(inspected.violations.some(item => item.id === 'nested_repository' && item.kind === 'definite'),
      JSON.stringify(inspected));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('starting in a subfolder stops a box command left running by a dead CLI of the parent', { timeout: 90000 },
  async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-orphan-'));
  const work = path.join(root, 'work'); const sub = path.join(work, 'sub'); const agent = path.join(root, 'agent');
  mkdirSync(sub, { recursive: true }); mkdirSync(agent);
  writeFileSync(path.join(work, '.gitignore'), 'sub/\n'); repository(work);
  writeFileSync(path.join(sub, 'a.txt'), 'a'); repository(sub);
  const model = await modelServer([{ tool: 'run', args: { timeout_s: 60, command: "while ($true) { " +
    "Add-Content (Join-Path $env:HOME 'heartbeat.txt') 'tick'; Start-Sleep -Milliseconds 100 }" } }]);
  const id = `orphan-${process.pid}`;
  const parent = path.join(root, 'parent.json'); const child = path.join(root, 'child.json');
  writeFileSync(parent, JSON.stringify({ id, goal: 'beat', workspace: work, model: 'gpt-6.1-terra', effort: 'medium',
    max_quota_percent: 10, base_url: model.url }));
  writeFileSync(child, JSON.stringify({ id: `${id}-child`, goal: 'finish', workspace: sub, model: 'gpt-6.1-terra',
    effort: 'medium', max_quota_percent: 10, base_url: model.url }));
  const dirs: string[] = [];
  try {
    const first = cli(['run', parent], agent);
    const runs = path.resolve('runs');
    const limit = Date.now() + 30000;
    let heartbeat = '';
    while (!heartbeat || !existsSync(heartbeat) || readFileSync(heartbeat).length < 10) {
      if (Date.now() > limit) throw new Error('command did not start');
      const name = readdirSync(runs).find(item => item.startsWith(`${id}-`) && !item.includes('child'));
      if (name) heartbeat = path.join(runs, name, 'scratch', 'heartbeat.txt');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    dirs.push(path.dirname(path.dirname(heartbeat)));
    first.child.kill(); await first.done;
    // Control: the command in the box outlives its CLI.
    const before = readFileSync(heartbeat).length;
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.ok(readFileSync(heartbeat).length > before);
    const second = await cli(['run', child], agent).done; if (second.run_dir) dirs.push(second.run_dir);
    assert.notEqual(second.reason, 'workspace_busy', JSON.stringify(second));
    const stopped = readFileSync(heartbeat).length;
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(readFileSync(heartbeat).length, stopped);
  } finally {
    await model.close();
    for (const dir of dirs) { reap(dir); rmSync(dir, { recursive: true, force: true }); }
    rmSync(root, { recursive: true, force: true });
  }
});

test('more replies than requests fails the audit', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-replies-'));
  const termsFile = path.join(root, 'terms'); writeFileSync(termsFile, 'forbidden-word-alpha\n');
  writeFileSync(path.join(root, 'task.json'), JSON.stringify({ clean_room: {}, forbidden_terms_file: termsFile,
    read_roots: [], box: 'mxc' }));
  writeFileSync(path.join(root, 'ledger.jsonl'), JSON.stringify({ clean_room: { manifest_sha256: 'test',
    terms_file_sha256: hash(readFileSync(termsFile)) } }) + '\n' +
    JSON.stringify({ usage: { input: 1, cached: 0, output: 1, reasoning: 0 } }) + '\n');
  try { assert.deepEqual(audit(root).mismatch, ['more replies than requests']); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('the examples are valid tasks and declarations', () => {
  const run = (...args: string[]) => {
    const child = spawnSync(process.execPath, [path.resolve('src/cli.ts'), ...args], { encoding: 'utf8' });
    assert.equal(child.status, 1); return JSON.parse(child.stdout);
  };
  for (const name of ['task.json', 'task-unity.json', 'task-research.json', 'task-clean.json', 'task-mcp.json']) {
    // Validation comes first, so reaching the missing workspace means every key and shape was accepted.
    assert.equal(run('run', path.resolve('examples', name)).reason, 'Workspace does not exist', name);
  }
  assert.notEqual(run('clean-copy', path.resolve('examples', 'clean-copy.json')).reason, 'Invalid declaration');
});
