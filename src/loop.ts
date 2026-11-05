import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { runPowerShell, staysInside } from './box.ts';
import { gitData, inspectDiff, type Scope, type Violation } from './rules.ts';
import type { Answer } from './tools.ts';
import { hostJob, type HostTask } from './host.ts';
import { scanDiff } from './clean.ts';

type Task = HostTask & { goal: string; read_roots?: string[]; acceptance?: ({ id: string; command: string;
  timeout_s: number } | { id: string; host_job: string; args?: Record<string, string> })[];
  questions?: { id: string; text: string; refs?: number; sources?: number }[]; max_continues?: number;
  box?: 'mxc' | 'none'; env?: Record<string, string>; path?: string[];
  scope?: Scope; clean_room?: { manifest: string }; forbidden_terms_file?: string | null };
type Finish = { state: 'done' | 'blocked'; summary: string; answers?: Answer[] };
type Check = { id: string; status: string; exit_code: number | null; run_id: string; duration_ms: number;
  reused?: boolean };
type Result = { status: string; state: string | null; summary: string; reason: string | null; checks: Check[];
  diff: { files: string[]; added: number; deleted: number }; violations: Violation[]; continues: number };

// What each rule asks for. A rule's name alone left a worker guessing: one asked to write review.md wrote it again and
// again, and spent three rounds on "new_doc: review.md:1" before giving up.
const violationHint: Record<string, string> = {
  out_of_scope: 'this task does not allow changes to this file; undo them',
  protected: 'this file is protected; undo the change',
  new_doc: 'this task does not allow new README or .md files; remove it, or if the task asks for it, finish as blocked and say so',
  new_dep: 'this task does not allow new dependencies; solve it with what is there, or finish as blocked and say so',
  suppression: 'remove this and fix what it hides',
  leftover: 'finish this TODO or FIXME and remove it',
  swallow: 'this catch ignores the error; handle it, or say in a comment why ignoring it is safe',
  nested_repository: 'remove this nested git repository',
  forbidden_term: 'remove the forbidden term from this file',
};

// One question per "## " section of a spec in the workspace. Tests rarely look at every line of a spec, so a
// worker could finish with part of it skipped; refs asks for one path:line per bullet of the section.
export function specQuestions(workspace: string, file: string) {
  if (!staysInside(workspace, path.join(workspace, file))) throw new Error(`Spec is outside the workspace: ${file}`);
  return readFileSync(path.join(workspace, file), 'utf8').replace(/\r\n/g, '\n').split(/^## /m).slice(1)
    .map(section => { const heading = section.split('\n')[0].trim();
      return { id: `${file} ${heading}`, text: `Every item in "${heading}" of ${file} is met. Give one path:line ` +
        'per item as evidence.', refs: Math.max(1, section.split('\n').filter(line => /^\s*[-*] /.test(line)).length) };
    });
}

// Evidence counts when it starts with path:line of an existing workspace file and the line is inside it.
function pointsIn(workspace: string, item: string) {
  const match = /^`?(.+?):(\d+)/.exec(item.trim()); if (!match) return false;
  const file = path.resolve(workspace, match[1]); const relative = path.relative(workspace, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !staysInside(workspace, file) ||
      !existsSync(file) || !statSync(file).isFile()) return false;
  return Number(match[2]) >= 1 && Number(match[2]) <= readFileSync(file, 'utf8').split('\n').length;
}

export async function settledPrompt(session: AgentSession, message: string) {
  let settled!: () => void;
  const done = new Promise<void>(resolve => { settled = resolve; });
  const unsubscribe = session.subscribe(event => { if (event.type === 'agent_settled') settled(); });
  try { await session.prompt(message); await done; } finally { unsubscribe(); }
}

export async function runLoop(session: AgentSession, task: Task, runDir: string, result: Result,
  getFinish: () => Finish | undefined, clearFinish: () => void, head: string | null, flush: () => Promise<void>,
  checkGate: () => void, initialMessage?: string) {
  const logDir = path.join(runDir, 'logs'); mkdirSync(logDir, { recursive: true });
  let toolCalls = 0; let idle = 0; let challenged = false; const seenSuspects = new Set<string>();
  // finish is not work, so calling it again does not count as progress.
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'tool_execution_start' && event.toolName !== 'finish') toolCalls++;
  });
  try {
    let message = initialMessage ?? task.goal +
      (task.questions?.length ? `\nQuestions: ${JSON.stringify(task.questions)}` : '');
    for (;;) {
      clearFinish(); const before = toolCalls;
      await settledPrompt(session, message);
      await flush(); checkGate();
      const finish = getFinish();
      const last = [...session.messages].reverse().find(item => item.role === 'assistant');
      if (!finish && last?.role === 'assistant' && last.stopReason === 'error') {
        throw new Error(`Model request failed: ${last.errorMessage ?? 'Unknown error'}`);
      }
      if (result.continues > 0) idle = toolCalls === before ? idle + 1 : 0;
      if (finish) { result.state = finish.state; result.summary = finish.summary; }
      if (finish?.state === 'blocked') {
        // Workers often call unfinished work "blocked". Ask once; a block repeated at once, with no work in
        // between, goes back to the caller.
        if (challenged && toolCalls === before) { result.status = 'blocked'; result.reason = finish.summary; return; }
        challenged = true; result.reason = finish.summary;
        if (result.continues >= (task.max_continues ?? 5)) { result.status = 'needs_judgment'; return; }
        message = 'finish(blocked) is only for something your tools cannot resolve: missing files or access, a ' +
          'contradiction in the task, or a decision only the task owner can make. Remaining work, a large task or ' +
          'many steps are not blockers. Continue toward the goal and call finish(done) when every condition is ' +
          'met. If you really are blocked, call finish(blocked) again now and name the blocker and its evidence.';
        result.continues++; continue;
      }
      challenged = false;
      const failures: string[] = [];
      if (!finish) {
        const open = [...(task.acceptance ?? []).map(c => c.id), ...(task.questions ?? []).map(q => q.id)].join(', ');
        failures.push(`You stopped without calling finish. Conditions still open: ${open || 'none listed'}. ` +
          'Continue the work, then call finish.');
      }
      else {
        result.checks = [];
        // A check that rewrites files would leave a submitted version none of the checks saw.
        const checked = task.acceptance?.length
          ? (await gitData(task.workspace, runDir, 'state', '', task.box)).content : null;
        for (const check of task.acceptance ?? []) {
          if ('host_job' in check) {
            const run = await hostJob(task, runDir, check.host_job, check.args, true);
            result.checks.push({ id: check.id, status: run.status, exit_code: run.exit_code,
              run_id: run.run_id ?? run.job_id, duration_ms: run.duration_ms, reused: run.reused });
            if (run.status !== 'passed') failures.push(`${check.id}: status=${run.status}` +
              (run.tail ? `\n${run.tail.join('\n')}` : run.summary ? `\n${JSON.stringify(run.summary)}` : ''));
            continue;
          }
          const run_id = randomUUID(); const logPath = path.join(logDir, `${run_id}.log`);
          const run = await runPowerShell({ workspace: task.workspace, box: task.box, env: task.env, path: task.path,
            scratch: path.join(runDir, 'scratch'),
            readRoots: task.read_roots ?? [], logPath, timeoutMs: check.timeout_s * 1000 }, check.command);
          const passed = run.status === 'exited' && run.exitCode === 0;
          result.checks.push({ id: check.id, status: passed ? 'passed' : 'failed', exit_code: run.exitCode, run_id,
            duration_ms: run.durationMs });
          if (!passed) {
            const tail = readFileSync(logPath, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n')
              .slice(-20).map(line => line.slice(0, 500)).join('\n');
            failures.push(`${check.id}: exit_code=${run.exitCode}, status=${run.status}\n${tail}`);
          }
        }
        if (checked && (await gitData(task.workspace, runDir, 'state', '', task.box)).content !== checked) {
          failures.push('The acceptance checks changed files, so what was checked is not what is submitted. ' +
            'Call finish again once the checks leave the files as they are.');
        }
        for (const question of task.questions ?? []) {
          const answer = finish.answers?.find(item => item.id === question.id);
          if (!answer || !['confirmed',
            'inferred'].includes(answer.status) || !answer.conclusion.trim() ||
            !answer.evidence.some(item => item.trim())) {
            failures.push(`${question.id}: answer or evidence missing`); continue;
          }
          const refs = question.refs ? answer.evidence.filter(item => pointsIn(task.workspace, item)).length : 0;
          if (refs < (question.refs ?? 0)) failures.push(`${question.id}: needs ${question.refs} path:line ` +
            `evidence items (one per item of the section) that exist in the workspace, found ${refs}`);
          if (question.sources) {
            const ledger = path.join(runDir, 'ledger.jsonl');
            const rows = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
              .map(line => JSON.parse(line)) : [];
            const valid = new Set(rows.filter(row => row.web === 'fetch' && row.status >= 200 &&
              row.status < 300 && /^web:[a-f0-9-]{36}$/.test(row.id)).map(row => row.id));
            // An item may go on with a quote after the id, which is what makes the evidence easy to check later.
            const found = new Set(answer.evidence.map(item => /^web:[a-f0-9-]{36}/.exec(item.trim())?.[0])
              .filter(id => id && valid.has(id))).size;
            if (found < question.sources) failures.push(`${question.id}: needs ${question.sources} fetched sources ` +
              `(web:<id> from web_fetch), found ${found}`);
          }
        }
        if (head) {
          const inspected = inspectDiff(await gitData(task.workspace, runDir, 'diff', head, task.box), task.scope);
          if (task.clean_room && task.forbidden_terms_file) {
            const hits = await scanDiff(task.workspace, runDir, head, task.forbidden_terms_file);
            for (const file of hits) inspected.violations.push({ id: 'forbidden_term', path: file,
              line: 1, kind: 'definite' });
          }
          result.diff = inspected.diff; result.violations = inspected.violations;
          // A runaway diff must not turn into a huge prompt; the full list stays in the result.
          for (const violation of inspected.violations.slice(0,
            30)) failures.push(`${violation.id}: ${violation.path}:${violation.line}${violationHint[violation.id] ? ` (${violationHint[violation.id]})` : ''}`);
          if (inspected.violations.length > 30) {
            failures.push(`and ${inspected.violations.length - 30} more violations`);
          }
          if (inspected.violations.some(v => v.kind === 'suspect' && seenSuspects.has(`${v.id}:${v.path}:${v.line}`))) {
            result.status = 'needs_judgment'; result.reason = failures.join('\n'); return;
          }
          for (const v of inspected.violations.filter(v => v.kind === 'suspect')) {
            seenSuspects.add(`${v.id}:${v.path}:${v.line}`);
          }
        }
        if (!failures.length) { result.status = 'completed'; result.reason = null; return; }
      }
      result.reason = failures.join('\n');
      if (idle >= 2 || result.continues >= (task.max_continues ?? 5)) { result.status = 'needs_judgment'; return; }
      message = finish ? `${failures.join('\n')}\nThe harness checked your finish and these are not met. ` +
        'Keep the acceptance conditions and fix these, then call finish again.' : failures.join('\n');
      result.continues++;
    }
  } finally { unsubscribe(); }
}
