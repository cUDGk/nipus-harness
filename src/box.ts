import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync,
  rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onPath } from './boxed/which.mjs';

// Settings of this machine that have no place in a repository, kept beside the login in harness.json.
export function machineSetting(name: 'search_url' | 'hide_env'): string | undefined {
  const dir = process.env.HARNESS_AGENT_DIR ?? fileURLToPath(new URL('../.agent', import.meta.url));
  try { return JSON.parse(readFileSync(path.join(dir, 'harness.json'), 'utf8'))[name]; }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}

const secretNames =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|WEBHOOK|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CONNECTION_STRING|DATABASE_URL|COOKIE|^HARNESS_/i;
// hide_env adds what this machine wants kept from children, such as the variables of the program that started the harness.
const hideEnv = machineSetting('hide_env');
export const secretEnvironment = hideEnv ? new RegExp(`${secretNames.source}|${hideEnv}`, 'i') : secretNames;

export interface BoxRequest {
  workspace: string;
  scratch?: string;
  command: string[];
  readRoots?: string[];
  env?: Record<string, string>;
  box?: 'mxc' | 'none';
  path?: string[];
  timeoutMs: number;
  logPath: string;
  maxLogBytes?: number;
}
export interface BoxResult {
  status: 'exited' | 'timeout' | 'output_limit' | 'infra_error';
  exitCode: number | null;
  durationMs: number;
  logPath: string;
  logBytes: number;
  error?: string;
}

export async function runPowerShell(req: Omit<BoxRequest, 'command'>, script: string): Promise<BoxResult> {
  const scratch = req.scratch!;
  checkScratch(scratch);
  mkdirSync(scratch, { recursive: true });
  const file = path.join(scratch, `script-${randomUUID()}.ps1`);
  const encoding = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' +
    '$OutputEncoding = [Console]::OutputEncoding;\n';
  writeFileSync(file, '\ufeff' + encoding + script + '\nif ($?) { exit 0 } else { exit 1 }\n', 'utf8');
  try {
    return await runBoxed({ ...req, command: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      `iex ([IO.File]::ReadAllText('${file.replaceAll("'", "''")}'))`] });
  } finally { rmSync(file, { force: true }); }
}

const npmCodex = String.raw`node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor` +
  String.raw`\x86_64-pc-windows-msvc\bin\codex.exe`;

// The box is the sandbox of the Codex CLI. Its npm install puts a codex.cmd shim on PATH, which can't start without a
// shell, so this takes the real program beside it.
export function codexExecutable(env: NodeJS.ProcessEnv = process.env) {
  if (env.HARNESS_CODEX_EXE) return env.HARNESS_CODEX_EXE;
  for (const name of ['codex.exe', 'codex.cmd']) {
    let found: string;
    try { found = onPath(name, env); } catch { continue; } // Not under this name; the error below covers having neither.
    if (name === 'codex.exe') return found;
    const file = path.join(path.dirname(found), npmCodex);
    if (existsSync(file)) return file;
  }
  throw new Error('Codex CLI not found: install it with npm install -g @openai/codex, or set HARNESS_CODEX_EXE');
}

const launcher = fileURLToPath(new URL('./boxed/launch.mjs', import.meta.url));
const key = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const within = (p: string, parent: string) => key(p) === key(parent) || key(p).startsWith(key(parent) + path.sep);
const actual = (p: string): string => {
  const resolved = path.resolve(p);
  if (existsSync(resolved)) return realpathSync.native(resolved);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(actual(parent), path.basename(resolved));
};

// A worker can swap a folder for a junction, so a path it can write under is only read outside the box after this.
export const staysInside = (root: string, file: string) => within(actual(file), actual(root));

export function validateRoot(root: string) {
  root = actual(root);
  const home = actual(os.homedir());
  const forbidden = [path.join(home, '.codex'), path.join(home, '.ssh'),
    fileURLToPath(new URL('../.agent', import.meta.url))
  ].map(actual);
  if (/['\r\n]/.test(root) || within(home, root) || key(root) === key(path.parse(root).root) ||
      forbidden.some(p => within(root, p) || within(p, root))) throw new Error('Forbidden workspace or read root');
}

export function validateEnvironment(req: Pick<BoxRequest, 'box' | 'env' | 'path' | 'readRoots'>) {
  for (const [name, value] of Object.entries(req.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' ||
        (req.box !== 'none' && /^(HOME|USERPROFILE)$/i.test(name))) throw new Error('Invalid environment');
  }
  for (const dir of req.path ?? []) {
    if (!path.isAbsolute(dir) || (req.box !== 'none' &&
        !(req.readRoots ?? []).some(root => within(actual(dir), actual(root))))) throw new Error('Invalid path entry');
  }
}

// The box hides the system and global git config, but files were checked out using their line
// ending setting. Without the same value every CRLF file looks modified. Reading config runs nothing.
let autocrlf: string | undefined;
const hostAutocrlf = (): string => {
  if (autocrlf !== undefined) return autocrlf;
  try {
    const value = execFileSync(onPath('git'), ['config', '--get', 'core.autocrlf'], { cwd: os.homedir(), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    autocrlf = /^(true|false|input)$/i.test(value) ? value : 'false';
  } catch {
    autocrlf = 'false'; // git exits with 1 when the key is not set.
  }
  return autocrlf;
};

// What a .git file held before the worker could act. The box cannot protect a .git that does not exist yet, and a .git
// file the worker wrote would name folders for the read list. First use in a process counts; resume passes the saved.
const trustedGit = new Map<string, string | null>();
export function gitFileContent(workspace: string) {
  const file = path.join(workspace, '.git');
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null;
}
export const trustGit = (workspace: string, content: string | null) => trustedGit.set(key(actual(workspace)), content);

// The worker can turn a folder it may write, even the top one, into a junction to anywhere. Without these two checks
// the next command would get access at the junction's target. A workspace or read root may lawfully be reached through
// a link, so its real path is fixed before the worker can act. The harness's own scratch is never a link.
const trustedRoots = new Map<string, string>();
export const realPath = (item: string) => actual(item);
export const trustRoot = (item: string, real: string) =>
  trustedRoots.set(path.resolve(item).toLowerCase(), key(real));
export function checkScratch(scratch: string) {
  try { if (lstatSync(scratch).isSymbolicLink()) throw new Error('Scratch is a link'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}

export async function runBoxed(req: BoxRequest): Promise<BoxResult> {
  // Validate paths before creating any files or starting processes.
  for (const p of [req.workspace, req.logPath, ...(req.scratch ? [req.scratch] : []), ...(req.readRoots ?? [])]) {
    if (!path.isAbsolute(p) || /['\r\n]/.test(p)) throw new Error('Invalid path');
  }
  if (req.scratch) checkScratch(req.scratch);
  for (const root of [req.workspace, ...(req.readRoots ?? [])]) {
    const name = path.resolve(root).toLowerCase();
    if (!trustedRoots.has(name)) trustedRoots.set(name, key(actual(root)));
    if (trustedRoots.get(name) !== key(actual(root))) throw new Error('Workspace or read root moved');
  }
  const workspace = actual(req.workspace);
  if (within(actual(req.logPath), workspace)) throw new Error('Log must be outside workspace');
  validateRoot(workspace);
  const gitFile = path.join(workspace, '.git');
  const gitRoots: string[] = [];
  const content = gitFileContent(workspace);
  if (!trustedGit.has(key(workspace))) trustedGit.set(key(workspace), content);
  if (trustedGit.get(key(workspace)) !== content) throw new Error('Invalid git file');
  if (content !== null) {
    if (!within(actual(gitFile), workspace)) throw new Error('Invalid git file');
    const match = /^gitdir: ([^'\r\n]+)\r?\n?$/.exec(content);
    if (!match) throw new Error('Invalid gitdir');
    const gitdir = actual(path.resolve(workspace, match[1]));
    validateRoot(gitdir);
    const commonFile = path.join(gitdir, 'commondir');
    if (!within(actual(commonFile), gitdir)) throw new Error('Invalid commondir file');
    const common = readFileSync(commonFile, 'utf8');
    if (!/^[^'\r\n]+\r?\n?$/.test(common)) throw new Error('Invalid commondir');
    gitRoots.push(gitdir, actual(path.resolve(gitdir, common.replace(/\r?\n$/, ''))));
  }
  const readRoots = [...new Map([...(req.readRoots ?? []), ...gitRoots, ...(req.scratch ? [path.dirname(launcher),
    path.dirname(process.execPath)] : [])].map(actual).map(root => [key(root), root])).values()];
  const scratch = req.scratch ? actual(req.scratch) : workspace;
  for (const root of [workspace, scratch, ...readRoots]) {
    // A junction target is not covered by the check above and ends up in a TOML literal string.
    validateRoot(root);
  }
  validateEnvironment(req);
  if (!req.command.length || req.command.some(s => typeof s !== 'string' || s.includes('\0')) ||
      !Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0 ||
      (req.maxLogBytes !== undefined && (!Number.isFinite(req.maxLogBytes) || req.maxLogBytes < 0))) {
    throw new Error('Invalid request');
  }
  const start = Date.now();
  let fd: number | undefined;
  let bytes = 0;
  const result = (status: BoxResult['status'], exitCode: number | null, error?: string): BoxResult => ({ status,
    exitCode, durationMs: Date.now() - start, logPath: req.logPath, logBytes: bytes, ...(error ? { error } : {}) });
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'OS',
      'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'ProgramData', 'ALLUSERSPROFILE']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    // MXC requires the host's LOCALAPPDATA to prepare its sandbox.
    if (process.env.LOCALAPPDATA) env.LOCALAPPDATA = process.env.LOCALAPPDATA;
    const windows = process.env.SystemRoot ?? String.raw`C:\Windows`;
    // The harness's own Node is already a read root when scratch is set; expose it so Node projects can run.
    env.PATH = [path.join(windows, 'System32'), windows, path.join(windows, 'System32', 'WindowsPowerShell',
      'v1.0'), String.raw`C:\Program Files\dotnet`, String.raw`C:\Program Files\Git\cmd`,
      ...(req.scratch ? [path.dirname(process.execPath)] : [])].filter(existsSync).join(path.delimiter);
    for (const [name, dir] of Object.entries({ TEMP: '.tmp', TMP: '.tmp', DOTNET_CLI_HOME: '.dotnet-home',
      NUGET_PACKAGES: '.nuget-packages', APPDATA: '.appdata' })) {
      env[name] = path.join(scratch, dir);
      mkdirSync(env[name], { recursive: true });
    }
    // Keep tools' user data out of the host profile. Git takes HOME first; without it git reads the host
    // ~/.gitconfig, which the box denies, and every git command ends with "fatal: unknown error".
    Object.assign(env, { USERPROFILE: scratch, HOME: scratch, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false', EnableSourceControlManagerQueries: 'false',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: hostAutocrlf(),
      // The box denies lstat on the drive root, which Node's default realpath walk of the entry and imports hits.
      NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main' }, req.env);
    if (req.box === 'none') {
      for (const name of Object.keys(env)) delete env[name];
      for (const [name, value] of Object.entries(process.env)) {
        if (!secretEnvironment.test(name)) env[name] = value;
      }
      Object.assign(env, req.env);
    }
    if (req.path?.length) env.PATH = [...req.path, env.PATH ?? ''].join(path.delimiter);
    // cmd.exe and programs started from it honour this. It does not replace onPath, which covers what the harness starts.
    env.NoDefaultCurrentDirectoryInExePath = '1';
    fd = openSync(req.logPath, 'w');
    // Hand the sandbox the checked real paths so a junction swapped afterwards changes nothing.
    const workspaceAccess = existsSync(path.join(workspace, '.git'))
      ? "':workspace_roots'={'.'='write', '.git'='read'}"
      : "':workspace_roots'={'.'='write'}";
    const fs = ["':minimal'='read'", workspaceAccess, ...(req.scratch ? [`'${scratch}'='write'`] : []),
      ...readRoots.map(p => `'${p}'='read'`)].join(', ');
    const scratchEnv = req.box === 'none' ? {} : Object.fromEntries(['TEMP', 'TMP', 'DOTNET_CLI_HOME',
      'NUGET_PACKAGES', 'APPDATA', 'USERPROFILE', 'HOME'].map(name => [name, env[name]]));
    const argument = path.join(scratch, `launch-${randomUUID()}.json`);
    if (req.scratch) writeFileSync(argument, JSON.stringify({ command: req.command, env: scratchEnv }));
    const command = req.scratch ? [process.execPath, '--preserve-symlinks-main', launcher, argument] : req.command;
    const args = ['-c', 'windows.sandbox=mxc', '-c', 'default_permissions="lean"', '-c',
      `permissions={lean={filesystem={${fs}}, network={enabled=false}}}`, 'sandbox', '--include-managed-config',
      '--permission-profile', 'lean', '-C', workspace, '--', ...command];
    const child = spawn(req.box === 'none' ? command[0] : codexExecutable(), req.box === 'none' ? command.slice(1) : args,
      { shell: false, cwd: workspace, env, stdio: ['ignore', fd, fd],
      windowsHide: true });
    if (child.pid && req.box !== 'none') {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch { /* The process already ended, or the change was denied. The priority is only a courtesy. */ }
    }
    let status: BoxResult['status'] = 'exited';
    let killing = false;
    let killFailed = false;
    let killerDone: Promise<void> | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let resolveDeadline: (() => void) | undefined;
    const deadlineReached = new Promise<{ code: null; failed: boolean; stuck: boolean }>(resolve => {
      resolveDeadline = () => resolve({ code: null, failed: false, stuck: true });
    });
    const kill = () => {
      if (killing || !child.pid) return;
      killing = true;
      // A failed taskkill is hard to reproduce safely; bound the wait even if it fails.
      deadline = setTimeout(() => resolveDeadline?.(), 10000);
      const killer = spawn(path.join(windows, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)],
        { stdio: 'ignore', windowsHide: true });
      killerDone = new Promise(resolve => {
        killer.once('error', () => { killFailed = true; resolve(); });
        killer.once('close', code => { if (code !== 0) killFailed = true; resolve(); });
      });
    };
    const timer = setTimeout(() => { if (status === 'exited') { status = 'timeout'; kill(); } }, req.timeoutMs);
    const monitor = setInterval(() => {
      try {
        if (status === 'exited' && fstatSync(fd!).size > (req.maxLogBytes ?? 10 * 1024 * 1024)) {
          status = 'output_limit'; kill();
        }
      } catch { /* Closed after exit. */ }
    }, 50);
    let outcome = await Promise.race([deadlineReached, new Promise<{ code: number | null; failed: boolean;
      stuck: boolean }>(resolve => {
      child.once('error', () => resolve({ code: null, failed: true, stuck: false }));
      child.once('close', code => resolve({ code, failed: false, stuck: false }));
    })]);
    if (!outcome.stuck && killerDone) {
      const waited = await Promise.race([deadlineReached, killerDone.then(() => null)]);
      if (waited) outcome = waited;
    }
    clearTimeout(timer);
    clearInterval(monitor);
    if (req.scratch) rmSync(argument, { force: true });
    if (deadline) clearTimeout(deadline);
    bytes = fstatSync(fd).size;
    if (status === 'exited' && bytes > (req.maxLogBytes ?? 10 * 1024 * 1024)) status = 'output_limit';
    if (outcome.stuck || killFailed) return result('infra_error', null, 'Failed to terminate sandbox process tree');
    if (outcome.failed) return result('infra_error', null, 'Failed to start sandbox');
    if (status === 'exited' && outcome.code !== 0) {
      const prefix = Buffer.alloc(128);
      const log = openSync(req.logPath, 'r');
      try { if (prefix.subarray(0, readSync(log, prefix, 0, prefix.length,
        0)).toString().startsWith('Error: failed to prepare MXC sandbox:')) return result('infra_error', null,
        'Failed to prepare MXC sandbox'); }
      finally { closeSync(log); }
    }
    return result(status, status === 'exited' ? outcome.code : null);
  } catch {
    return result('infra_error', null, 'Failed to prepare or run sandbox');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
