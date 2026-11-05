import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { quotaOf, type Usage } from './gate.ts';
import { onPath } from './boxed/which.mjs';

// A power cut leaves either the old file or the whole new one, never an empty or partial file.
function atomicWrite(file: string, text: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx');
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}
export const atomicJson = (file: string, value: unknown) => atomicWrite(file, JSON.stringify(value) + '\n');

export function ledgerUsage(file: string) {
  const usage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, quota_percent: 0,
    by_role: {} as Record<string, Usage> };
  let lastRequest: string | null = null;
  let quotaFailure = false;
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  for (const [index, line] of lines.entries()) {
    let row;
    // The last line can be torn by a power cut or be mid-append while status reads it.
    try { row = JSON.parse(line); } catch (error) { if (index === lines.length - 1) break; throw error; }
    if (row.sha256) lastRequest = row.time;
    if (row.quota_read_failed) quotaFailure = true;
    if (row.usage) {
      const targets: Usage[] = [usage];
      if (typeof row.role === 'string') targets.push(usage.by_role[row.role] ??= {
        calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, quota_percent: 0 });
      for (const target of targets) {
        target.calls++;
        for (const key of ['input', 'cached', 'output', 'reasoning'] as const) target[key] += row.usage[key];
        // Rows from before the per-model weights have no quota of their own.
        target.quota_percent += row.quota ?? quotaOf(row.usage);
      }
    }
  }
  return { usage, lastRequest, quotaFailure };
}

// A power cut leaves a torn last line or trailing NUL blocks. Drop only that line so later appends stay valid.
export function repairLogs(runDir: string) {
  const sessionDir = path.join(runDir, 'session');
  const files = [path.join(runDir, 'ledger.jsonl'), path.join(runDir, 'host-jobs.jsonl'),
    ...(existsSync(sessionDir) ? readdirSync(sessionDir)
    .filter(item => item.endsWith('.jsonl')).map(item => path.join(sessionDir, item)) : [])];
  for (const file of files.filter(item => existsSync(item))) {
    const content = readFileSync(file, 'utf8');
    if (content.endsWith('\n') || !content) continue;
    const last = content.lastIndexOf('\n');
    // Atomic, or a second power cut during this repair would lose the good lines too.
    let whole = false;
    try { JSON.parse(content.slice(last + 1)); whole = true; } catch { /* Torn: drop it below. */ }
    atomicWrite(file, whole ? content + '\n' : content.slice(0, last + 1));
  }
}

type Process = { ProcessId: number; CommandLine: string | null; CreationDate: string };
// Every process the box starts names the run's scratch folder. The run folder alone is not enough: the shell that
// launched "resume <run_dir>" or "stop <run_dir>" names it too, so ancestors of this query are left out as well.
const query = "$ErrorActionPreference='Stop'; $p=[int]$env:HARNESS_QUERY_PID; $d=$env:HARNESS_QUERY_DIR; " +
  '$all=@(Get-CimInstance Win32_Process); $by=@{}; foreach ($x in $all) { $by[[int]$x.ProcessId]=$x }; ' +
  '$up=@{}; $at=[int]$PID; while ($by.ContainsKey($at) -and -not $up.ContainsKey($at)) { $up[$at]=1; ' +
  '$at=[int]$by[$at].ParentProcessId }; @($all | Where-Object { ($p -gt 0 -and $_.ProcessId -eq $p) -or (-not ' +
  '$up.ContainsKey([int]$_.ProcessId) -and $_.CommandLine -and ' +
  // Only the three forms the box itself starts. Another run may pass this scratch path as an argument to its own work.
  '$_.CommandLine.IndexOf($d,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and (' +
  "$_.CommandLine.IndexOf(($d+'''=''write'''),[StringComparison]::OrdinalIgnoreCase) -ge 0 -or " +
  "($_.CommandLine -match 'launch\\.mjs' -and $_.CommandLine.IndexOf(($d+'\\launch-')," +
  '[StringComparison]::OrdinalIgnoreCase) -ge 0) -or ' +
  "($_.CommandLine -match 'ReadAllText' -and $_.CommandLine.IndexOf(($d+'\\script-')," +
  '[StringComparison]::OrdinalIgnoreCase) -ge 0))) } | ' +
  'ForEach-Object { @{ProcessId=$_.ProcessId;CommandLine=$_.CommandLine;' +
  "CreationDate=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress";

function processes(dir: string, pid = 0): Process[] {
  const output = execFileSync(onPath('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8', windowsHide: true, shell: false,
    env: { ...process.env, HARNESS_QUERY_PID: String(pid), HARNESS_QUERY_DIR: path.resolve(dir, 'scratch') },
  }).trim();
  if (!output) return [];
  const value = JSON.parse(output);
  return Array.isArray(value) ? value : [value];
}

export function isRunning(dir: string, state: { pid?: number; process_started_at?: number }) {
  if (!Number.isInteger(state.pid) || !Number.isFinite(state.process_started_at)) return false;
  return processes(dir, state.pid).some(p => p.ProcessId === state.pid && /cli\.ts/i.test(p.CommandLine ?? '') &&
    Math.abs(Date.parse(p.CreationDate) - state.process_started_at!) <= 5000);
}

export function reap(dir: string, cliPid?: number) {
  const list = processes(dir, cliPid).filter(p => p.ProcessId !== process.pid);
  const mcpDir = path.join(dir, 'mcp');
  if (existsSync(mcpDir)) for (const name of readdirSync(mcpDir)) {
    try {
      const saved = JSON.parse(readFileSync(path.join(mcpDir, name, 'process.json'), 'utf8'));
      if (Number.isInteger(saved.pid) && Number.isFinite(saved.started_at) && saved.pid !== process.pid) {
        // The time guards against the same number now belonging to another process.
        const match = processes(dir, saved.pid).find(p => p.ProcessId === saved.pid &&
          Math.abs(Date.parse(p.CreationDate) - saved.started_at) < 5000);
        if (match && !list.some(p => p.ProcessId === match.ProcessId)) list.push(match);
      }
    } catch { /* Missing or stale process record. */ }
  }
  const killed: number[] = [];
  for (const p of list) {
    try {
      execFileSync(onPath('taskkill.exe'), ['/T', '/F', '/PID', String(p.ProcessId)],
        { stdio: 'ignore', shell: false });
      killed.push(p.ProcessId);
    } catch {
      if (processes(dir, p.ProcessId).some(item => item.ProcessId === p.ProcessId)) throw new Error('reap_failed');
    }
  }
  return killed;
}

const help = `Usage: node src/cli.ts <command> [arguments]
  run <task.json>
  mcp-tools <task.json>
  clean-copy <declaration.json>
  audit <run_dir>
  export <run_dir> <out.patch>
  resume <run_dir> [--max-quota-percent <number>]
  status [run_dir ...] | status --active
  stop <run_dir>
  login
  help
Task: id, goal, workspace, model, effort, read_roots, forbidden_terms_file,
  max_quota_percent, max_run_s, base_url, acceptance, questions, specs,
  max_continues, scope, roles, box, env, path, host_jobs, host_queue_timeout_s, clean_room, web, mcp, service_tier.
  model: any gpt name; one pi does not list borrows the terra entry and counts as the dearest for the budget.
  service_tier: "default" or "priority" (fast). Only this field decides it, for every request of the run.
  mcp: per server command, tools (the only ones the worker sees), env, timeout_s, start_timeout_s, lock.
  web: search_url, fetch, max_requests, allow_unboxed; questions may require sources.
  box: "mxc" (default) or "none"; env: name/value map; path: tool directories.
  host_jobs: named commands with args patterns, timeout_s, lock or unity_project,
    output (tail or summary), and summary_file for summary output.
  acceptance: command/timeout_s, or host_job/args for a declared job.
`;

export function command(args: string[]): boolean {
  if (!args.length || args[0] === 'help') { process.stdout.write(help); return true; }
  if (!['status', 'stop'].includes(args[0])) return false;
  if (args[0] === 'stop') {
    if (args.length !== 2) throw new Error('Invalid stop arguments');
    const dir = path.resolve(args[1]);
    const resultFile = path.join(dir, 'result.json');
    if (existsSync(resultFile)) {
      process.stdout.write(JSON.stringify({ run_dir: dir, already_finished: true, pids: [] }) + '\n');
      return true;
    }
    const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const task = JSON.parse(readFileSync(path.join(dir, 'task.json'), 'utf8'));
    const pids = reap(dir, isRunning(dir, state) ? state.pid : undefined);
    if (!existsSync(resultFile)) atomicJson(resultFile, { id: task.id, status: 'cancelled', reason: 'stopped',
      run_dir: dir, usage: ledgerUsage(path.join(dir, 'ledger.jsonl')).usage });
    process.stdout.write(JSON.stringify({ run_dir: dir, pids }) + '\n');
    return true;
  }
  const active = args[1] === '--active';
  if (active && args.length !== 2) throw new Error('Invalid status arguments');
  const root = path.resolve(import.meta.dirname, '../runs');
  const dirs = active || args.length === 1 ? (existsSync(root) ? readdirSync(root)
    .filter(name => !name.startsWith('.')).map(p => path.join(root, p)) : []) : args.slice(1).map(p => path.resolve(p));
  for (const dir of dirs) {
    try {
      const resultFile = path.join(dir, 'result.json');
      const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
      if (active && result) continue; // A result means the run has ended.
      // A run that failed during setup has only its result, with no task or state to read.
      if (result && !existsSync(path.join(dir, 'task.json'))) {
        process.stdout.write(JSON.stringify({ run_dir: dir, id: result.id, state: result.status, usage: result.usage,
          ...('reason' in result ? { reason: result.reason } : {}) }) + '\n');
        continue;
      }
      const task = JSON.parse(readFileSync(path.join(dir, 'task.json'), 'utf8'));
      const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      const status = result?.status ?? (isRunning(dir, state) ? 'running' : 'interrupted');
      const ledger = ledgerUsage(path.join(dir, 'ledger.jsonl'));
      process.stdout.write(JSON.stringify({ run_dir: dir, id: task.id, model: task.model, effort: task.effort,
        service_tier: task.service_tier ?? 'default',
        state: status, pid: state.pid ?? null, resumes: state.resumes, started_at: state.started_at ?? null,
        last_request_at: ledger.lastRequest, usage: ledger.usage,
        ...(result && 'reason' in result ? { reason: result.reason } : {})
      }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ run_dir: dir, error: error instanceof Error ? error.message : String(error)
      }) + '\n');
    }
  }
  return true;
}
