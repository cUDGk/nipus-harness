import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runBoxed, trustGit } from '../src/box.ts';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';

function tempRoot(): string {
  const base = path.resolve('.test-tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'box-'));
}

test('scratch is writable, its sibling is not, and dotnet leaves the workspace clean', async () => {
  const root = tempRoot(); const workspace = path.join(root, 'work'); const scratch = path.join(root, 'scratch');
  mkdirSync(workspace);
  try {
    writeFileSync(path.join(workspace, '.gitignore'), 'bin/\nobj/\n');
    writeFileSync(path.join(workspace, 'app.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n');
    writeFileSync(path.join(workspace, 'Program.cs'), 'System.Console.WriteLine("ok");\n');
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'add', '.']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
    const logPath = path.join(root, 'log');
    const command = `Set-Content -LiteralPath '${path.join(scratch, 'control')}' -Value 'allowed'; Set-Content -LiteralPath '${path.join(root, 'sibling')}' -Value 'rejected' -ErrorAction SilentlyContinue; dotnet build --nologo; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $status = @(git -c core.fsmonitor=false -c core.hooksPath=NUL -c diff.external= status --short); [IO.File]::WriteAllText('${path.join(scratch, 'status')}', ($status -join "\`n")); if ($env:TEMP -ne '${path.join(scratch, '.tmp')}') { exit 9 }`;
    const result = await runBoxed({ workspace, scratch, logPath, timeoutMs: 120000, command: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command] });
    assert.equal(result.exitCode, 0, readFileSync(logPath, 'utf8'));
    assert.ok(existsSync(path.join(scratch, 'control'))); assert.equal(existsSync(path.join(root, 'sibling')), false);
    assert.equal(readFileSync(path.join(scratch, 'status'), 'utf8'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the harness Node is on PATH with scratch and absent without it', async () => {
  const root = tempRoot(); const workspace = path.join(root, 'work'); const scratch = path.join(root, 'scratch');
  mkdirSync(workspace);
  try {
    writeFileSync(path.join(workspace, 'lib.mjs'), "export const version = process.version;\n");
    writeFileSync(path.join(workspace, 'v.mjs'), "import { writeFileSync } from 'node:fs';\nimport { version } from './lib.mjs';\nwriteFileSync(process.argv[2], version);\n");
    writeFileSync(path.join(workspace, 'a.test.mjs'), "import { test } from 'node:test';\nimport { version } from './lib.mjs';\ntest('imports', () => { if (!version) throw new Error('empty'); });\n");
    const logPath = path.join(root, 'log');
    const ps = (command: string) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command];
    const result = await runBoxed({ workspace, scratch, logPath, timeoutMs: 60000, command: ps(`node .\\v.mjs '${path.join(scratch, 'version')}'; if ($LASTEXITCODE) { exit $LASTEXITCODE }; node --test; exit $LASTEXITCODE`) });
    assert.equal(result.exitCode, 0, readFileSync(logPath, 'utf8'));
    assert.equal(readFileSync(path.join(scratch, 'version'), 'utf8'), process.version);
    const control = await runBoxed({ workspace, logPath, timeoutMs: 60000, command: ps('if (Get-Command node -ErrorAction SilentlyContinue) { exit 7 }; exit 0') });
    assert.equal(control.exitCode, 0, readFileSync(logPath, 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace git metadata is read-only', async () => {
  const root = tempRoot();
  const workspace = path.join(root, 'work');
  mkdirSync(workspace);
  try {
    execFileSync('git.exe', ['init', workspace], { stdio: 'ignore' });
    const config = path.join(workspace, '.git', 'config');
    const before = readFileSync(config);
    const logPath = path.join(root, 'git-log');
    const script = 'echo work> control.txt & echo hook> .git\\hooks\\test-hook & echo bad>> .git\\config & git status --short & if errorlevel 1 exit /b 10 & git diff & if errorlevel 1 exit /b 11';
    const result = await runBoxed({ workspace, logPath, timeoutMs: 15000, command: ['cmd.exe', '/d', '/c', script] });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.equal(result.exitCode, 0, readFileSync(logPath, 'utf8'));
    assert.ok(existsSync(path.join(workspace, 'control.txt')));
    assert.equal(existsSync(path.join(workspace, '.git', 'hooks', 'test-hook')), false);
    assert.deepEqual(readFileSync(config), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('worktrees have writable files and isolated read-only git metadata', async () => {
  const root = tempRoot();
  const repo = path.join(root, 'repo'); const a = path.join(root, 'a'); const b = path.join(root, 'b');
  try {
    mkdirSync(repo); writeFileSync(path.join(repo, 'tracked.txt'), 'original\n');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'a', a]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'b', b]);
    writeFileSync(path.join(a, 'private.txt'), 'canary-a'); writeFileSync(path.join(b, 'private.txt'), 'canary-b');
    execFileSync('git', ['-C', repo, 'config', 'harness.canary', 'metadata-readable']);
    const config = path.join(repo, '.git', 'config'); const before = readFileSync(config);
    const gitFile = readFileSync(path.join(a, '.git'));
    const gitdir = path.resolve(readFileSync(path.join(a, '.git'), 'utf8').trim().slice(8));
    const head = readFileSync(path.join(gitdir, 'HEAD'));
    const commondir = readFileSync(path.join(gitdir, 'commondir'));
    const run = async (work: string, other: string, index: string) => {
      const logPath = path.join(root, index + '.log');
      const script = `Add-Content tracked.txt changed; try { Add-Content .git bad -ErrorAction Stop } catch {}; $g = git rev-parse --absolute-git-dir; $c = git rev-parse --git-common-dir; try { Add-Content (Join-Path $g HEAD) bad -ErrorAction Stop } catch {}; try { Add-Content (Join-Path $g commondir) bad -ErrorAction Stop } catch {}; try { Add-Content (Join-Path $c config) bad -ErrorAction Stop } catch {}; git config --get harness.canary; git symbolic-ref HEAD; Get-Content private.txt; try { Get-Content '${path.join(other, 'private.txt')}' -ErrorAction Stop } catch {}; git status --short; if ($LASTEXITCODE -ne 0) { exit 10 }; git diff; exit $LASTEXITCODE`;
      const result = await runBoxed({ workspace: work, logPath, timeoutMs: 30000, command: ['powershell.exe', '-NoProfile', '-Command', script] });
      assert.equal(result.exitCode, 0, readFileSync(logPath, 'utf8'));
      return readFileSync(logPath, 'utf8');
    };
    const outcomes = await Promise.allSettled([run(a, b, 'a'), run(b, a, 'b')]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    const [logA, logB] = outcomes.map(outcome => (outcome as PromiseFulfilledResult<string>).value);
    assert.match(logA, /canary-a/); assert.doesNotMatch(logA, /canary-b/);
    assert.match(logB, /canary-b/); assert.doesNotMatch(logB, /canary-a/);
    assert.match(logA, /metadata-readable/); assert.match(logA, /refs\/heads\/a/);
    assert.match(logA, /changed/); assert.match(logB, /changed/);
    assert.deepEqual(readFileSync(config), before); assert.deepEqual(readFileSync(path.join(a, '.git')), gitFile);
    assert.deepEqual(readFileSync(path.join(gitdir, 'HEAD')), head);
    assert.deepEqual(readFileSync(path.join(gitdir, 'commondir')), commondir);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid worktree metadata is rejected before starting the box', async () => {
  const root = tempRoot(); const workspace = path.join(root, 'work'); const gitdir = path.join(root, 'metadata');
  mkdirSync(workspace); mkdirSync(gitdir);
  const request = { workspace, logPath: path.join(root, 'log'), timeoutMs: 10000, command: ['cmd.exe', '/c', 'exit'] };
  try {
    // Each content is trusted first so that its shape is what gets checked. Untrusted changes are refused anyway.
    for (const content of ['invalid\n', "gitdir: bad'path\n", 'gitdir: one\ntwo\n', `gitdir: ${os.homedir()}\n`]) {
      writeFileSync(path.join(workspace, '.git'), content);
      trustGit(workspace, content);
      await assert.rejects(runBoxed(request));
      assert.equal(existsSync(request.logPath), false);
    }
    writeFileSync(path.join(workspace, '.git'), 'gitdir: ../metadata\n');
    await assert.rejects(runBoxed(request), /Invalid git file/);
    trustGit(workspace, 'gitdir: ../metadata\n');
    for (const content of ["bad'path\n", 'one\ntwo\n']) {
      writeFileSync(path.join(gitdir, 'commondir'), content);
      await assert.rejects(runBoxed(request));
      assert.equal(existsSync(request.logPath), false);
    }
    writeFileSync(path.join(gitdir, 'commondir'), '.\n');
    const control = await runBoxed(request);
    assert.equal(control.exitCode, 0, JSON.stringify(control));
    assert.equal(existsSync(request.logPath), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace read control', async () => {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'work');
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, 'inside.txt'), 'box-control');
    const logPath = path.join(root, 'log');
    const result = await runBoxed({ workspace, logPath, timeoutMs: 30000, command: ['cmd.exe', '/d', '/c', 'type inside.txt'] });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.equal(result.exitCode, 0, readFileSync(logPath, 'utf8'));
    assert.match(readFileSync(logPath, 'utf8'), /box-control/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('timeout removes descendants', async () => {
  const root = tempRoot();
  const marker = `BoxTree${process.pid}${Date.now()}`;
  try {
    const workspace = path.join(root, 'work');
    mkdirSync(workspace);
    const script = `@echo off\r\nstart "" /b powershell.exe -NoProfile -Command "Set-Content started.txt '${marker}'; Start-Sleep -Seconds 60 # ${marker}"\r\npowershell.exe -NoProfile -Command "Start-Sleep -Seconds 60"\r\n`;
    writeFileSync(path.join(workspace, 'tree.cmd'), script);
    const result = await runBoxed({ workspace, logPath: path.join(root, 'log'), timeoutMs: 2000, command: ['cmd.exe', '/d', '/c', '.\\tree.cmd'] });
    assert.equal(result.status, 'timeout', JSON.stringify(result));
    assert.match(readFileSync(path.join(workspace, 'started.txt'), 'utf8'), new RegExp(marker));
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne $PID } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' });
    assert.equal(output.trim(), '', `Remaining processes: ${output}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('timeout with scratch removes the launcher and descendants', async () => {
  const root = tempRoot();
  const marker = `BoxScratch${process.pid}${Date.now()}`;
  try {
    const workspace = path.join(root, 'work');
    mkdirSync(workspace);
    const script = `@echo off\r\nstart "" /b powershell.exe -NoProfile -Command "Set-Content started.txt '${marker}'; Start-Sleep -Seconds 60 # ${marker}"\r\npowershell.exe -NoProfile -Command "Start-Sleep -Seconds 60"\r\n`;
    writeFileSync(path.join(workspace, 'tree.cmd'), script);
    const result = await runBoxed({ workspace, scratch: path.join(root, 'scratch'), logPath: path.join(root, 'log'), timeoutMs: 3000, command: ['cmd.exe', '/d', '/c', '.\\tree.cmd'] });
    assert.equal(result.status, 'timeout', JSON.stringify(result));
    assert.match(readFileSync(path.join(workspace, 'started.txt'), 'utf8'), new RegExp(marker));
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne $PID } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' });
    assert.equal(output.trim(), '', `Remaining processes: ${output}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('COM timeout removes descendants', async () => {
  const root = tempRoot();
  const marker = `BoxCom${process.pid}${Date.now()}`;
  try {
    const workspace = path.join(root, 'work');
    mkdirSync(workspace);
    const result = await runBoxed({ workspace, logPath: path.join(root, 'log'), timeoutMs: 2500, command: ['powershell.exe', '-NoProfile', '-Command', `Set-Content started.txt '${marker}'; (New-Object -ComObject Shell.Application).ShellExecute('cmd.exe','/c exit','','hide')`] });
    assert.equal(result.status, 'timeout', JSON.stringify(result));
    assert.match(readFileSync(path.join(workspace, 'started.txt'), 'utf8'), new RegExp(marker));
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne $PID } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' });
    assert.equal(output.trim(), '', `Remaining processes: ${output}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('normal exit removes descendants', async () => {
  const root = tempRoot();
  const marker = `BoxExit${process.pid}${Date.now()}`;
  try {
    const workspace = path.join(root, 'work');
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, 'tree.cmd'), `@echo off\r\nstart "" /b powershell.exe -NoProfile -Command "Set-Content started.txt '${marker}'; Start-Sleep -Seconds 60 # ${marker}"\r\n:wait\r\nif not exist started.txt goto wait\r\nexit /b 0\r\n`);
    const result = await runBoxed({ workspace, logPath: path.join(root, 'log'), timeoutMs: 5000, command: ['cmd.exe', '/d', '/c', '.\\tree.cmd'] });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.match(readFileSync(path.join(workspace, 'started.txt'), 'utf8'), new RegExp(marker));
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne $PID } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' });
    assert.equal(output.trim(), '', `Remaining processes: ${output}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read and write boundaries, environment and allowed roots', async () => {
  const root = tempRoot();
  const old = process.env.BOX_TEST_SECRET_TOKEN;
  try {
    const workspace = path.join(root, 'work');
    const a = path.join(root, 'allowed');
    const b = path.join(root, 'outside');
    for (const p of [workspace, a, b]) mkdirSync(p);
    writeFileSync(path.join(a, 'a.txt'), 'allowed-marker');
    writeFileSync(path.join(b, 'b.txt'), 'outside-marker');
    process.env.BOX_TEST_SECRET_TOKEN = 'test-secret-only-9327';
    writeFileSync(path.join(workspace, 'boundary.cmd'), `@echo off\r\necho write-control> write-control.txt\r\ntype "${path.join(a, 'a.txt')}"\r\ntype "${path.join(b, 'b.txt')}" > loot.txt\r\necho denied > "${path.join(b, 'write.txt')}"\r\nset\r\n`);
    const logPath = path.join(root, 'log');
    const result = await runBoxed({ workspace, logPath, timeoutMs: 10000, readRoots: [a], command: ['cmd.exe', '/d', '/c', '.\\boundary.cmd'] });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /allowed-marker/);
    assert.match(log, /^TEMP=/im);
    assert.match(readFileSync(path.join(workspace, 'write-control.txt'), 'utf8'), /write-control/);
    assert.doesNotMatch(log, /test-secret-only-9327|BOX_TEST_SECRET_TOKEN/);
    assert.ok(!existsSync(path.join(workspace, 'loot.txt')) || !readFileSync(path.join(workspace, 'loot.txt'), 'utf8').includes('outside-marker'));
    assert.equal(existsSync(path.join(b, 'write.txt')), false);
  } finally {
    if (old === undefined) delete process.env.BOX_TEST_SECRET_TOKEN; else process.env.BOX_TEST_SECRET_TOKEN = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid paths are rejected', async () => {
  const root = tempRoot();
  const workspace = path.join(root, 'work'); mkdirSync(workspace);
  const logPath = path.join(root, 'log');
  const req = { workspace, logPath, timeoutMs: 1000, command: ['cmd.exe'] };
  try {
  for (const bad of ['relative', `${workspace}'bad`, `${workspace}\nbad`]) {
    await assert.rejects(runBoxed({ ...req, workspace: bad }));
    await assert.rejects(runBoxed({ ...req, logPath: bad }));
    await assert.rejects(runBoxed({ ...req, readRoots: [bad] }));
  }
  await assert.rejects(runBoxed({ ...req, logPath: path.join(workspace, 'log') }));
  for (const bad of [os.homedir(), path.dirname(os.homedir()), path.parse(workspace).root, path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.codex', 'sub'), path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.ssh', 'sub'), path.resolve('.agent'), path.resolve('.agent', 'sub'), path.resolve('.')]) {
    await assert.rejects(runBoxed({ ...req, readRoots: [bad] }), bad);
    await assert.rejects(runBoxed({ ...req, workspace: bad }), bad);
  }
  const link = path.join(root, 'home-link');
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, os.homedir()], { stdio: 'ignore' });
  await assert.rejects(runBoxed({ ...req, readRoots: [link] }));
  await assert.rejects(runBoxed({ ...req, workspace: link }));
  const workLink = path.join(root, 'work-link');
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', workLink, workspace], { stdio: 'ignore' });
  await assert.rejects(runBoxed({ ...req, logPath: path.join(workLink, 'new-log') }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sandbox preparation failures are infrastructure errors', async () => {
  const root = tempRoot(); const workspace = path.join(root, 'work'); mkdirSync(workspace);
  try {
    const result = await runBoxed({ workspace, logPath: path.join(root, 'log'), timeoutMs: 10000, env: { LOCALAPPDATA: '' }, command: ['cmd.exe', '/d', '/c', 'exit 0'] });
    assert.equal(result.status, 'infra_error', JSON.stringify(result));
    assert.equal(result.exitCode, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('output limit terminates producer', async () => {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'work'); mkdirSync(workspace);
    writeFileSync(path.join(workspace, 'output.cmd'), '@echo off\r\n:loop\r\necho 0123456789012345678901234567890123456789\r\ngoto loop\r\n');
    const result = await runBoxed({ workspace, logPath: path.join(root, 'log'), timeoutMs: 10000, maxLogBytes: 4096, command: ['cmd.exe', '/d', '/c', '.\\output.cmd'] });
    assert.equal(result.status, 'output_limit', JSON.stringify(result));
    assert.ok(result.logBytes > 4096);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('escape routes, network, outside process and ACL state', async () => {
  const root = tempRoot();
  const workspace = path.join(root, 'work'); const outside = path.join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside);
  const canary = path.join(outside, 'canary.txt'); const loot = path.join(workspace, 'loot.txt');
  const state = path.join(os.homedir(), '.codex', '.sandbox', 'deny_read_acl_state.json');
  const hash = () => existsSync(state) ? createHash('sha256').update(readFileSync(state)).digest('hex') : 'absent';
  const before = hash();
  const acl = () => execFileSync('icacls.exe', [outside], { encoding: 'utf8' });
  const denyBefore = /\(DENY\)/i.test(acl());
  const victim = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 120'], { stdio: 'ignore', windowsHide: true });
  const server = http.createServer((_req, res) => res.end('loopback-control'));
  try {
    writeFileSync(canary, 'unique-canary-content');
    writeFileSync(path.join(workspace, 'control.txt'), 'escape-control');
    writeFileSync(path.join(workspace, 'escape.cmd'), '@echo off\r\ntype control.txt > loot.txt\r\n');
    const control = await runBoxed({ workspace, logPath: path.join(root, 'log-control'), timeoutMs: 10000, command: ['cmd.exe', '/d', '/c', '.\\escape.cmd'] });
    assert.equal(control.status, 'exited'); assert.equal(control.exitCode, 0);
    assert.match(readFileSync(loot, 'utf8'), /escape-control/);
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(workspace, 'hostlink'), outside], { stdio: 'ignore' });
    const unc = canary.replace(/^([A-Za-z]):/, '\\\\localhost\\$1$');
    const linuxCanary = '/mnt/' + canary[0].toLowerCase() + canary.slice(2).replaceAll('\\', '/');
    const linuxLoot = '/mnt/' + loot[0].toLowerCase() + loot.slice(2).replaceAll('\\', '/');
    const cases: Record<string, string> = {
      direct: `type "${canary}" > loot.txt`,
      dotdot: 'type ..\\outside\\canary.txt > loot.txt',
      host_junction: 'type hostlink\\canary.txt > loot.txt',
      own_junction: `mklink /J ownlink "${outside}" & type ownlink\\canary.txt > loot.txt`,
      unc: `type "${unc}" > loot.txt`,
      long_path: `type "\\\\?\\${canary}" > loot.txt`,
      powershell: `powershell -NoProfile -Command "Get-Content -LiteralPath '${canary}' | Set-Content loot.txt"`,
      wsl: `wsl.exe -d Ubuntu-24.04 -- cp "${linuxCanary}" "${linuxLoot}"`,
      wmi: `powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c copy ${canary} ${loot}'}"`,
      schtasks: `schtasks /create /tn CodexHarnessBoxTest /tr "cmd /c copy ${canary} ${loot}" /sc once /st 23:59 /f & schtasks /run /tn CodexHarnessBoxTest`,
      com: `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).ShellExecute('cmd.exe','/c copy ${canary} ${loot}','','hide')"`,
      start: `start "" /b cmd /c copy "${canary}" loot.txt`,
    };
    for (const [name, command] of Object.entries(cases)) {
      rmSync(loot, { force: true });
      writeFileSync(path.join(workspace, 'escape.cmd'), `@echo off\r\n${command}\r\n`);
      const result = await runBoxed({ workspace, logPath: path.join(root, `log-${name}`), timeoutMs: name === 'com' ? 2500 : 10000, command: ['cmd.exe', '/d', '/c', '.\\escape.cmd'] });
      assert.notEqual(result.status, 'infra_error', name);
      if (['wmi', 'schtasks', 'com', 'start'].includes(name)) await new Promise(resolve => setTimeout(resolve, 1500));
      assert.ok(!existsSync(loot) || !readFileSync(loot, 'utf8').includes('unique-canary-content'), name);
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const localUrl = `http://127.0.0.1:${address.port}/`;
    const hostResponse = await new Promise<string>((resolve, reject) => {
      http.get(localUrl, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body)); }).on('error', reject);
    });
    assert.equal(hostResponse, 'loopback-control');
    for (const host of ['http://example.com/', 'http://1.1.1.1/', localUrl]) {
      const result = await runBoxed({ workspace, logPath: path.join(root, `net-${host === localUrl ? 'local' : host.includes('example') ? 'dns' : 'ip'}`), timeoutMs: 10000, command: ['curl.exe', '--max-time', '3', host] });
      assert.equal(result.status, 'exited', host); assert.notEqual(result.exitCode, 0, host);
    }
    const result = await runBoxed({ workspace, logPath: path.join(root, 'kill-log'), timeoutMs: 10000, command: ['taskkill.exe', '/F', '/PID', String(victim.pid)] });
    assert.equal(result.status, 'exited');
    assert.notEqual(result.exitCode, 0);
    assert.equal(victim.exitCode, null);
    assert.ok(victim.pid); process.kill(victim.pid, 0);
    assert.equal(hash(), before);
    assert.equal(/\(DENY\)/i.test(acl()), denyBefore);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    try { execFileSync('schtasks.exe', ['/delete', '/tn', 'CodexHarnessBoxTest', '/f'], { stdio: 'ignore' }); } catch { /* Task may never have been created. */ }
    if (victim.exitCode === null) victim.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('UTF-8, git, dotnet and Python', async () => {
  const root = tempRoot(); const workspace = path.join(root, 'work'); mkdirSync(workspace);
  try {
    const run = async (name: string, command: string[], readRoots: string[] = []) => {
      const logPath = path.join(root, `log-${name}`);
      const result = await runBoxed({ workspace, logPath, timeoutMs: 60000, command, readRoots });
      assert.equal(result.status, 'exited', JSON.stringify(result));
      assert.equal(result.exitCode, 0, `${name}: ${readFileSync(logPath, 'utf8')}`);
      return readFileSync(logPath);
    };
    const japanese = Buffer.from('日本語のテスト\n', 'utf8');
    const output = await run('utf8', [process.execPath, '-e', "require('fs').writeFileSync('japanese.txt', '日本語のテスト\\n', 'utf8'); process.stdout.write('日本語のテスト\\n')"]);
    assert.deepEqual(output, japanese);
    assert.deepEqual(readFileSync(path.join(workspace, 'japanese.txt')), japanese);
    writeFileSync(path.join(workspace, 'setup-git.cmd'), '@echo off\r\nmkdir git-repo\r\ngit.exe -C git-repo init || exit /b 1\r\ngit.exe -C git-repo -c user.name=BoxTest -c user.email=box@example.invalid commit --allow-empty -m test || exit /b 1\r\n');
    await run('git', ['cmd.exe', '/d', '/c', '.\\setup-git.cmd']);
    const python = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Command python.exe -ErrorAction Stop).Source'], { encoding: 'utf8' }).trim();
    const pyout = await run('python', [python, '-c', 'print(42)'], [path.dirname(python)]);
    assert.match(pyout.toString(), /42/);
    await run('dotnet-new', ['dotnet.exe', 'new', 'console', '--no-restore', '-o', 'app']);
    writeFileSync(path.join(workspace, 'NuGet.Config'), '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear /></packageSources></configuration>');
    await run('dotnet-build', ['dotnet.exe', 'build', 'app', '--configfile', path.join(workspace, 'NuGet.Config')]);
    const dotnetOutput = await run('dotnet-run', ['dotnet.exe', 'run', '--project', 'app', '--no-build', '--no-restore']);
    assert.match(dotnetOutput.toString(), /Hello, World!/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('six parallel workspaces are isolated', async () => {
  const root = tempRoot();
  try {
    const works = Array.from({ length: 6 }, (_, i) => path.join(root, `work${i}`));
    for (const [i, work] of works.entries()) { mkdirSync(work); writeFileSync(path.join(work, 'inside.txt'), `inside-${i}`); }
    const results = await Promise.all(works.map((workspace, i) => runBoxed({ workspace, logPath: path.join(root, `log${i}`), timeoutMs: 15000, command: ['cmd.exe', '/d', '/c', `type inside.txt & type "${path.join(works[(i + 1) % 6], 'inside.txt')}"`] })));
    for (const [i, result] of results.entries()) {
      assert.equal(result.status, 'exited', JSON.stringify(result));
      const log = readFileSync(path.join(root, `log${i}`), 'utf8');
      assert.ok(log.includes(`inside-${i}`)); assert.ok(!log.includes(`inside-${(i + 1) % 6}`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('timing twenty short commands', async () => {
  const root = tempRoot(); const workspace = path.join(root, 'work'); mkdirSync(workspace);
  try {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await runBoxed({ workspace, logPath: path.join(root, `log${i}`), timeoutMs: 10000, command: ['cmd.exe', '/d', '/c', 'exit 0'] });
      assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0); times.push(result.durationMs);
    }
    times.sort((a, b) => a - b);
    console.log(`timing median=${(times[9] + times[10]) / 2}ms max=${times[19]}ms`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
