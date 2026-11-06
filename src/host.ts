import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import path from 'node:path';
import { runBoxed, staysInside } from './box.ts';
import { isRunning, reap } from './commands.ts';
import { appendLedger } from './gate.ts';
import { gitData } from './rules.ts';
import { activity, logOutput } from './tools.ts';

export type HostJob = { command: string[]; args?: Record<string, string>; timeout_s: number; lock?: string;
  unity_project?: string; output: 'tail' | 'summary'; summary_file?: string };
export type HostTask = { workspace: string; box?: 'mxc' | 'none'; host_jobs?: Record<string, HostJob>;
  host_queue_timeout_s?: number };
type Owner = { pid: number; process_started_at: number; run_dir: string; job: string };

const reserved = ['workspace', 'run_dir', 'job', 'log'];
const placeholder = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Names used by a job's command and summary file that neither the harness nor the job's args declare.
export function unknownPlaceholders(job: HostJob) {
  const known = [...reserved, ...Object.keys(job.args ?? {})];
  return [...job.command, job.summary_file ?? ''].flatMap(text => [...text.matchAll(placeholder)].map(m => m[1]))
    .filter(name => !known.includes(name));
}

const verified = new Map<string, number>();
// True while the CLI that wrote a lock lives. Asking Windows starts a process, so a live owner is re-checked rarely.
function ownerAlive(owner: Owner) {
  try { process.kill(owner.pid, 0); }
  catch (error: any) { if (error.code === 'ESRCH') return false; }
  const key = `${owner.pid}:${owner.process_started_at}`;
  const seen = verified.get(key);
  if (seen && Date.now() - seen < 300000) return true;
  if (!isRunning(owner.run_dir, owner)) return false;
  verified.set(key, Date.now());
  return true;
}

// A job left running by a dead CLI would overlap the next holder, unless that run was already resumed.
function reapOrphan(lockFile: string, owner: Owner | undefined) {
  if (!owner || typeof owner.run_dir !== 'string') return;
  const relative = path.relative(path.dirname(path.dirname(lockFile)), owner.run_dir);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  let state = {};
  try { state = JSON.parse(readFileSync(path.join(owner.run_dir, 'state.json'), 'utf8')); }
  catch { /* No readable state means no CLI can be proved alive, so the orphan check below still runs. */ }
  if (!isRunning(owner.run_dir, state)) reap(owner.run_dir);
}

// While a file is being deleted, Windows answers EPERM or EACCES to anyone opening it, and a reader can make a delete
// answer EBUSY. Six runs starting together do hit this. These all mean "look again at the next poll".
const inFlux = (error: any) => ['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code);
export const removeLock = (file: string) => rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 });

// The guard stops two waiters from both clearing one stale lock, which could delete the lock a third just took.
function clearStale(lockFile: string, seen: string, owner: Owner | undefined) {
  const guard = `${lockFile}.guard`;
  try { closeSync(openSync(guard, 'wx')); }
  catch (error: any) {
    if (error.code !== 'EEXIST' && !inFlux(error)) throw error;
    // A guard is held for seconds, so an old one was left by a crash.
    try { if (Date.now() - statSync(guard).mtimeMs > 30000) removeLock(guard); }
    catch (inner: any) { if (!inFlux(inner)) throw inner; }
    return;
  }
  try {
    if (readFileSync(lockFile, 'utf8') !== seen) return;
    reapOrphan(lockFile, owner);
    removeLock(lockFile);
  } catch (error: any) { if (!inFlux(error)) throw error; }
  finally { removeLock(guard); }
}

export const lockOwner = (runDir: string, job: string) => JSON.stringify({ pid: process.pid,
  process_started_at: Date.now() - process.uptime() * 1000, run_dir: runDir, job });
export function lockPath(name: string) {
  const root = path.resolve(import.meta.dirname, '../runs/.locks');
  mkdirSync(root, { recursive: true });
  return path.join(root, createHash('sha256').update(name).digest('hex') + '.lock');
}

// One holder per lock file across the PC. A holder that died leaves a stale file, which is cleared here.
export function takeLock(lockFile: string, owner: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx');
      try { writeFileSync(fd, owner); } finally { closeSync(fd); }
      return true;
    } catch (error: any) {
      if (error.code !== 'EEXIST') { if (inFlux(error)) return false; throw error; }
    }
    let seen: string;
    try { seen = readFileSync(lockFile, 'utf8'); }
    catch (error: any) { if (inFlux(error)) return false; throw error; }
    let current: Owner | undefined;
    try { current = JSON.parse(seen); }
    catch {
      // Empty or torn. A writer fills the file at once, so only an old one was left by a crash.
      try { if (Date.now() - statSync(lockFile).mtimeMs < 30000) return false; }
      catch (error: any) { if (inFlux(error)) return false; throw error; }
    }
    if (current && Number.isInteger(current.pid) && ownerAlive(current)) return false;
    clearStale(lockFile, seen, current);
  }
  return false;
}

// One writer for a folder and everything under it, so a folder and its subfolder cannot run at once either. The short
// table lock makes looking at the others and adding this one a single step. Live owners are only asked about when the
// paths overlap, because asking starts a process and six runs may start together.
export async function lockWorkspace(real: string, runDir: string) {
  const table = lockPath('workspace-table');
  const tableOwner = lockOwner(runDir, 'workspace-table');
  const limit = Date.now() + 30000;
  while (!takeLock(table, tableOwner)) {
    if (Date.now() >= limit) return undefined;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try {
    const mine = real.toLowerCase();
    const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
    for (const name of readdirSync(path.dirname(table)).filter(item => item.endsWith('.lock'))) {
      const file = path.join(path.dirname(table), name);
      let seen: string; let other: Owner & { workspace?: string };
      try { seen = readFileSync(file, 'utf8'); other = JSON.parse(seen); }
      catch { continue; } // Being written or removed. Its own owner still holds it through the exact lock below.
      if (typeof other.workspace !== 'string') continue;
      const theirs = other.workspace.toLowerCase();
      if (theirs === mine || !(inside(theirs, mine) || inside(mine, theirs))) continue;
      if (ownerAlive(other)) return undefined;
      // Its CLI died, but a job it left running could still write here, so that is stopped first.
      clearStale(file, seen, other);
    }
    const file = lockPath(`workspace:${mine}`);
    return takeLock(file, JSON.stringify({ ...JSON.parse(lockOwner(runDir, 'workspace')), workspace: real }))
      ? file : undefined;
  } finally { removeLock(table); }
}

// Unity keeps Temp\UnityLockfile open without sharing while it holds a project. A file that opens is a leftover.
function unityBusy(project: string) {
  const file = path.join(project, 'Temp', 'UnityLockfile');
  try { if (existsSync(file)) closeSync(openSync(file, 'r+')); return false; }
  catch { return true; }
}

// Runs a job the task declared, outside the box and one per lock across the PC, and records the workspace state.
export async function hostJob(task: HostTask, runDir: string, id: string, args: Record<string, string> = {},
  reuse = false) {
  const job_id = randomUUID();
  const started = Date.now();
  const base = { job_id, id, exit_code: null as number | null, duration_ms: 0,
    state_before: null as string | null, state_after: null as string | null };
  let result: Record<string, any> = { ...base, status: 'failed' };
  const job = task.host_jobs && Object.hasOwn(task.host_jobs, id) ? task.host_jobs[id] : undefined;
  const history = path.join(runDir, 'host-jobs.jsonl');
  const record = () => {
    result.duration_ms = Date.now() - started;
    appendFileSync(history, JSON.stringify({ ...result, args }) + '\n');
    appendLedger(path.join(runDir, 'ledger.jsonl'), { time: new Date().toISOString(),
      host_job: { id, status: result.status, state_before: result.state_before, state_after: result.state_after } });
    return result;
  };
  if (!job || !args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(k => !Object.hasOwn(job.args ?? {}, k)) ||
      Object.entries(job.args ?? {}).some(([k, pattern]) => {
        try { return typeof args[k] !== 'string' || !new RegExp(`^(?:${pattern})$(?![\\s\\S])`).test(args[k]); }
        catch { return true; }
      })) return record();
  const logDir = path.join(runDir, job.output === 'tail' ? 'logs' : 'host-logs');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(path.join(runDir, 'host'), { recursive: true });
  const log = path.join(logDir, `${job_id}.log`);
  const variables: Record<string, string> = { workspace: task.workspace, run_dir: runDir, job: job_id, log, ...args };
  const fill = (text: string) => text.replace(placeholder, (_, key: string) => variables[key]);
  if (unknownPlaceholders(job).length) return record();
  const command = job.command.map(fill);
  const summaryFile = job.summary_file ? fill(job.summary_file) : undefined;
  const state = async () => {
    const data = await gitData(task.workspace, runDir, 'state', '', task.box);
    if (!data.repository) throw new Error('not_repository');
    return data as { state: string; content: string };
  };
  let before: { state: string; content: string };
  try { before = await state(); result.state_before = before.state; } catch { return record(); }
  // Checked before queueing, so a job that already passed on this state does not wait for hours in line.
  if (reuse && existsSync(history)) {
    const rows = readFileSync(history, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const last = rows.reverse().find(row => row.id === id && row.status === 'passed' &&
      JSON.stringify(Object.entries(row.args ?? {}).sort()) === JSON.stringify(Object.entries(args).sort()));
    // A pass covers the files the job started from, so a job that changed them passed nothing about the result: it
    // runs again, and then finds them as they are. Ignored files are its own output, such as a build folder. Nothing
    // that could change files may have run since. A new process starts over.
    if (last && last.session === activity.session && last.activity === activity.count &&
        last.content_before === last.content_after && last.state_after === before.state) {
      result = { ...base, status: 'passed', state_before: before.state, state_after: before.state,
        content_before: before.content, content_after: before.content, reused: true, exit_code: 0,
        session: activity.session, activity: activity.count };
      return record();
    }
  }
  const lockFile = lockPath(job.unity_project ? path.resolve(job.unity_project).toLowerCase() : job.lock!);
  const owner = lockOwner(runDir, id);
  const limit = Date.now() + (task.host_queue_timeout_s ?? 7200) * 1000;
  let locked = false;
  try {
    for (;;) {
      locked = takeLock(lockFile, owner);
      if (locked && job.unity_project && unityBusy(job.unity_project)) {
        removeLock(lockFile);
        locked = false;
      }
      if (locked) break;
      if (Date.now() >= limit) { result.status = 'busy'; return record(); }
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1, limit - Date.now()))));
    }
    activity.count++;
    result.session = activity.session; result.activity = activity.count;
    const run = await runBoxed({ workspace: task.workspace, scratch: path.join(runDir, 'scratch'), box: 'none',
      command, logPath: log, timeoutMs: job.timeout_s * 1000, maxLogBytes: 64 * 1024 * 1024 });
    result.status = run.status === 'timeout' ? 'timeout' : run.status === 'infra_error' ? 'infra_error' :
      run.status === 'exited' && run.exitCode === 0 ? 'passed' : 'failed';
    result.exit_code = run.exitCode;
    const after = await state();
    result.state_after = after.state; result.content_before = before.content; result.content_after = after.content;
    if (job.output === 'tail') {
      result.run_id = job_id;
      Object.assign(result, logOutput(readFileSync(log, 'utf8'), run.status === 'output_limit'));
    } else {
      try {
        // Under the workspace or the box's scratch the worker can swap a folder for a junction to files outside.
        const root = [task.workspace, runDir].find(item => path.resolve(summaryFile!).toLowerCase()
          .startsWith(path.resolve(item).toLowerCase() + path.sep));
        if (!root || !staysInside(root, summaryFile!)) throw new Error('outside');
        result.summary = statSync(summaryFile!).size > 16384 ? { error: 'too_large' } :
          JSON.parse(readFileSync(summaryFile!, 'utf8'));
      } catch { result.summary = { error: 'unreadable' }; }
    }
  } catch { result.status = 'infra_error'; }
  finally { if (locked) removeLock(lockFile); }
  return record();
}
