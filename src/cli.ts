import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { appendLedger, BudgetExhausted, GateBlocked, installGate, type Usage } from './gate.ts';
import { delegate } from './delegate.ts';
import { checkEffort, createSession, inCatalog, modelFor, resolvedEffort, retrySettings } from './session.ts';
import { prompt } from './prompt.ts';
import { createTools, type Answer } from './tools.ts';
import { gitData, type Scope, type Violation } from './rules.ts';
import { runLoop, specQuestions } from './loop.ts';
import { atomicJson, command, isRunning, ledgerUsage, reap, repairLogs } from './commands.ts';
import { defaultAgentDir, login } from './login.ts';
import { hostJob, lockOwner, lockPath, lockWorkspace, removeLock, takeLock, unknownPlaceholders,
  type HostJob } from './host.ts';
import { gitFileContent, realPath, staysInside, trustGit, trustRoot, validateEnvironment } from './box.ts';
import { audit, cleanCopy, CleanBlocked, CleanFailure, exportPatch, verifyClean } from './clean.ts';
import { createWeb, searchUrl, type WebConfig } from './web.ts';
import { McpServer, type McpConfig } from './mcp.ts';
import { onPath } from './boxed/which.mjs';

export type Task = { id: string; goal: string; workspace: string; model: string; effort: ThinkingLevel;
  read_roots: string[]; forbidden_terms_file: string | null; max_quota_percent: number; max_run_s?: number;
  base_url: string | null; acceptance?: ({ id: string; command: string; timeout_s: number } |
    { id: string; host_job: string; args?: Record<string, string> })[];
  box?: 'mxc' | 'none'; env?: Record<string, string>; path?: string[];
  host_jobs?: Record<string, HostJob>; host_queue_timeout_s?: number;
  clean_room?: { manifest: string };
  web?: WebConfig; mcp?: Record<string, McpConfig>; service_tier?: 'default' | 'priority';
  questions?: { id: string; text: string; refs?: number; sources?: number }[]; specs?: string[]; max_continues?: number;
  scope?: Scope; roles?: Record<string,
  { model: string; effort: ThinkingLevel; tools: string[]; max_quota_percent: number }> };

function validateMcp(task: Record<string, unknown>) {
  const mcp = task.mcp;
  if (mcp === undefined) return;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) throw new Error('Invalid mcp');
  const positive = (value: unknown) => value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value > 0);
  const roots = [task.workspace, ...(Array.isArray(task.read_roots) ? task.read_roots : [])]
    .filter((root): root is string => typeof root === 'string');
  const plain = (text: string) => text.replace(/\//g, '\\').toLowerCase();
  for (const [name, raw] of Object.entries(mcp)) {
    const c = raw as McpConfig;
    // Two underscores would let mcp__a__b__c mean tool b__c of a or tool c of a__b.
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name.includes('__') || !c || typeof c !== 'object' || Array.isArray(c) ||
      Object.keys(c).some(k => !['command', 'tools', 'env', 'timeout_s', 'start_timeout_s', 'lock'].includes(k)) ||
      !Array.isArray(c.command) || !c.command.length || c.command.some(v => typeof v !== 'string' || !v) ||
      !Array.isArray(c.tools) || !c.tools.length || new Set(c.tools).size !== c.tools.length ||
      c.tools.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v) || `mcp__${name}__${v}`.length > 64) ||
      (c.env !== undefined && (!c.env || typeof c.env !== 'object' || Array.isArray(c.env) ||
        Object.entries(c.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string'))) ||
      !positive(c.timeout_s) || !positive(c.start_timeout_s) ||
      (c.lock !== undefined && (typeof c.lock !== 'string' || !c.lock))) throw new Error('Invalid mcp');
    if (task.box === 'none') continue;
    // A server runs outside the box, so code the boxed worker can write must not be what it starts.
    let executable = c.command[0];
    try { executable = onPath(executable); } catch { /* A missing executable is reported when the server starts. */ }
    // The env counts too: NODE_OPTIONS can name a file to load.
    const values = [...c.command.slice(1), ...Object.values(c.env ?? {})];
    if ([executable, ...values].some(p => path.isAbsolute(p) && roots.some(root => staysInside(root, p))) ||
      values.some(value => roots.some(root => plain(value).includes(plain(root))))) throw new Error('Invalid mcp');
  }
}

function validateTask(value: unknown): asserts value is Task {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task');
  const task = value as Record<string, unknown>;
  const keys = ['id', 'goal', 'workspace', 'model', 'effort', 'read_roots', 'forbidden_terms_file',
    'max_quota_percent', 'max_run_s', 'base_url', 'acceptance', 'questions', 'specs', 'max_continues', 'scope',
    'roles', 'box', 'env', 'path', 'host_jobs', 'host_queue_timeout_s', 'clean_room', 'web', 'mcp',
    'service_tier'];
  for (const key of Object.keys(task)) if (!keys.includes(key)) throw new Error(`Unknown task key: ${key}`);
  validateMcp(task);
  if (task.service_tier !== undefined && !['default', 'priority'].includes(task.service_tier as string)) {
    throw new Error('Invalid service_tier');
  }
  if (task.web !== undefined) {
    const web = task.web as WebConfig;
    if (!web || typeof web !== 'object' || Array.isArray(web) ||
      Object.keys(web).some(k => !['search_url', 'fetch', 'max_requests', 'allow_unboxed'].includes(k)) ||
      (web.fetch !== undefined && typeof web.fetch !== 'boolean') ||
      (web.allow_unboxed !== undefined && typeof web.allow_unboxed !== 'boolean') ||
      (web.max_requests !== undefined && (!Number.isSafeInteger(web.max_requests) || web.max_requests < 0))) {
      throw new Error('Invalid web');
    }
    searchUrl(web);
  }
  const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: any) => Array.isArray(v) && v.every(x => typeof x === 'string');
  const integer = (v: any) => Number.isSafeInteger(v) && v >= 0;
  const scope = task.scope as any;
  if (scope !== undefined && (!object(scope) || Object.keys(scope).some(k =>
    !['allow', 'protected', 'max_added_lines', 'allow_new_deps', 'allow_docs'].includes(k)) ||
    ['allow', 'protected'].some(k => scope[k] !== undefined && !strings(scope[k])) ||
    (scope.max_added_lines !== undefined && !integer(scope.max_added_lines)) ||
    ['allow_new_deps', 'allow_docs'].some(k => scope[k] !== undefined && typeof scope[k] !== 'boolean'))) {
    throw new Error('Invalid scope');
  }
  if (task.roles !== undefined && (!object(task.roles) || Object.entries(task.roles as object).some(([name, r]: any) =>
    !/^[A-Za-z0-9_-]+$/.test(name) || !object(r) ||
    Object.keys(r).some(k => !['model', 'effort', 'tools', 'max_quota_percent'].includes(k)) ||
    typeof r.model !== 'string' || !r.model.trim() || typeof r.effort !== 'string' || !strings(r.tools) ||
    typeof r.max_quota_percent !== 'number' || !Number.isFinite(r.max_quota_percent) || r.max_quota_percent < 0))) {
    throw new Error('Invalid role');
  }
  if (task.questions !== undefined) {
    const ids = new Set();
    if (!Array.isArray(task.questions) || task.questions.some((q: any) => !object(q) ||
      Object.keys(q).some(k => !['id', 'text', 'refs', 'sources'].includes(k)) ||
      typeof q.id !== 'string' || !q.id.trim() || ids.has(q.id) || !ids.add(q.id) ||
      typeof q.text !== 'string' || !q.text.trim() ||
      ['refs', 'sources'].some(k => q[k] !== undefined && !integer(q[k])))) throw new Error('Invalid questions');
  }
  if (task.max_continues !== undefined && !integer(task.max_continues)) throw new Error('Invalid max_continues');
  if (task.read_roots !== undefined && (!strings(task.read_roots) ||
    (task.read_roots as string[]).some(p => !path.isAbsolute(p)))) throw new Error('Invalid read_roots');
  if (task.clean_room !== undefined && (!task.clean_room || typeof task.clean_room !== 'object' ||
      Array.isArray(task.clean_room) || Object.keys(task.clean_room).some(k => k !== 'manifest') ||
      typeof (task.clean_room as any).manifest !== 'string' || !path.isAbsolute((task.clean_room as any).manifest))) {
    throw new Error('Invalid clean_room');
  }
  if (task.box !== undefined && task.box !== 'none' && task.box !== 'mxc') throw new Error('Invalid box');
  if (task.env !== undefined && (!task.env || typeof task.env !== 'object' || Array.isArray(task.env) ||
      Object.entries(task.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' ||
        (task.box !== 'none' && /^(HOME|USERPROFILE)$/i.test(k))))) throw new Error('Invalid env');
  if (task.path !== undefined && (!Array.isArray(task.path) || task.path.some(p =>
    typeof p !== 'string' || !path.isAbsolute(p)))) throw new Error('Invalid path');
  for (const key of ['id', 'goal', 'workspace', 'model', 'effort']) {
    if (typeof task[key] !== 'string' || !(task[key] as string).trim()) throw new Error(`Invalid ${key}`);
  }
  // A non-number here would compare as false in the gate and silently switch the budget off.
  if (task.max_quota_percent !== undefined && (typeof task.max_quota_percent !== 'number' ||
    !Number.isFinite(task.max_quota_percent) || task.max_quota_percent < 0)) {
    throw new Error('Invalid max_quota_percent');
  }
  if (task.host_queue_timeout_s !== undefined && (typeof task.host_queue_timeout_s !== 'number' ||
    !Number.isFinite(task.host_queue_timeout_s) || task.host_queue_timeout_s <= 0)) throw new Error('Invalid queue');
  if (task.host_jobs !== undefined && (!task.host_jobs || typeof task.host_jobs !== 'object' ||
    Array.isArray(task.host_jobs) || Object.values(task.host_jobs).some((j: any) => !j || typeof j !== 'object' ||
      Object.keys(j).some(k => !['command', 'args', 'timeout_s', 'lock', 'unity_project', 'output',
        'summary_file'].includes(k)) || !Array.isArray(j.command) || !j.command.length ||
      j.command.some((v: unknown) => typeof v !== 'string' || !v) ||
      typeof j.timeout_s !== 'number' || !Number.isFinite(j.timeout_s) || j.timeout_s <= 0 ||
      (('lock' in j) === ('unity_project' in j)) ||
      ('lock' in j && (typeof j.lock !== 'string' || !j.lock)) ||
      ('unity_project' in j && (typeof j.unity_project !== 'string' || !path.isAbsolute(j.unity_project))) ||
      !['tail', 'summary'].includes(j.output) ||
      (j.output === 'summary' && typeof j.summary_file !== 'string') ||
      (j.args !== undefined && (!j.args || typeof j.args !== 'object' || Array.isArray(j.args) ||
        Object.entries(j.args).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ||
          ['workspace', 'run_dir', 'job', 'log'].includes(k) || typeof v !== 'string')))))) {
    throw new Error('Invalid host_jobs');
  }
  for (const job of Object.values((task.host_jobs ?? {}) as Record<string, HostJob>)) {
    const unknown = unknownPlaceholders(job);
    if (unknown.length) throw new Error(`Unknown placeholder in host_jobs: ${unknown[0]}`);
  }
  if (task.acceptance !== undefined && (!Array.isArray(task.acceptance) || task.acceptance.some((item: any) =>
    !item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id ||
    ('host_job' in item ? Object.keys(item).some(k => !['id', 'host_job', 'args'].includes(k)) ||
      typeof item.host_job !== 'string' || !item.host_job :
      Object.keys(item).some(k => !['id', 'command', 'timeout_s'].includes(k)) ||
      typeof item.command !== 'string' || !item.command || typeof item.timeout_s !== 'number' ||
      !Number.isFinite(item.timeout_s) || item.timeout_s <= 0)))) {
    throw new Error('Invalid acceptance');
  }
  for (const item of (task.acceptance ?? []) as { host_job?: string }[]) {
    if (item.host_job && !Object.hasOwn((task.host_jobs ?? {}) as object, item.host_job)) {
      throw new Error(`Undeclared host job in acceptance: ${item.host_job}`);
    }
  }
  // Specs are read on the host and their headings sent to the model, so they must stay inside the workspace.
  if (task.specs !== undefined && (!Array.isArray(task.specs) || task.specs.some(file => typeof file !== 'string' ||
    !file || path.isAbsolute(file) || path.normalize(file).split(/[\\/]/).includes('..')))) {
    throw new Error('Invalid specs');
  }
}

async function main() {
  const usage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, quota_percent: 0,
    by_role: {} as Record<string, Usage> };
  const result: { id: string; status: string; state: string | null; summary: string; reason: string | null;
    usage: typeof usage; run_dir: string | null; checks: { id: string; status: string; exit_code: number | null;
    run_id: string; duration_ms: number }[]; diff: { files: string[]; added: number; deleted: number };
    violations: Violation[]; continues: number; warnings: string[] } = { id: '', status: 'failed', state: null,
    summary: '', reason: null, usage, run_dir: null, checks: [], diff: { files: [], added: 0, deleted: 0 },
    violations: [], continues: 0, warnings: [] };
  let restore: ReturnType<typeof installGate> | undefined;
  let workspaceLock: string | undefined;
  const mcpServers: McpServer[] = []; const mcpLocks: string[] = [];
  try {
    const resuming = process.argv[2] === 'resume';
    if ((!resuming && process.argv[2] !== 'run') || !process.argv[3]) throw new Error('Invalid command');
    const runDir = resuming ? path.resolve(process.argv[3]) : '';
    const raw: unknown = JSON.parse(readFileSync(resuming ? path.join(runDir, 'task.json') : process.argv[3], 'utf8'));
    validateTask(raw);
    const task = raw;
    if (task.mcp && task.clean_room) throw new CleanBlocked('mcp is not allowed in a clean room');
    if (task.web && task.clean_room) throw new CleanBlocked('web is not allowed in a clean room');
    if (task.web && task.box === 'none' && !task.web.allow_unboxed) throw new Error('web requires allow_unboxed');
    validateEnvironment({ box: task.box, env: task.env, path: task.path, readRoots: task.read_roots ?? [] });
    let previous: typeof result | undefined;
    let resumeNote = '';
    if (resuming) {
      const options = process.argv.slice(4);
      if (options.length % 2) throw new Error('Invalid resume arguments');
      for (let i = 0; i < options.length; i += 2) {
        if (options[i] === '--max-quota-percent') {
          const limit = Number(options[i + 1]);
          if (!Number.isFinite(limit) || limit < 0) throw new Error('Invalid max_quota_percent');
          task.max_quota_percent = limit;
        } else if (options[i] === '--message-file') {
          // The caller's answer to why the run stopped. Without it a worker told its block was invalid hears nothing new.
          resumeNote = readFileSync(options[i + 1], 'utf8').trim();
        } else throw new Error('Invalid resume arguments');
      }
      const resultFile = path.join(runDir, 'result.json');
      if (existsSync(resultFile)) {
        previous = JSON.parse(readFileSync(resultFile, 'utf8'));
        // blocked is resumable because the caller may judge the block invalid.
        if (!previous || !['budget_exhausted', 'failed', 'needs_judgment', 'blocked', 'cancelled']
          .includes(previous.status)) {
          throw new Error(`Cannot resume status: ${previous?.status}`);
        }
      }
    }
    result.id = task.id;
    if (!/^[a-zA-Z0-9_-]+$/.test(task.id) || !path.isAbsolute(task.workspace)) throw new Error('Invalid task');
    if (!existsSync(task.workspace)) throw new Error('Workspace does not exist');
    const activeDir = resuming ? runDir : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs',
      `${task.id}-${Date.now()}-${randomUUID()}`);
    const relative = path.relative(task.workspace, activeDir);
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
      throw new Error('Run directory inside workspace');
    }
    mkdirSync(activeDir, { recursive: true });
    const stateFile = path.join(activeDir, 'state.json');
    const state = resuming ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    if (resuming && isRunning(activeDir, state)) throw new Error('already_running');
    // Two writers in one folder would undo each other, and the dirty check cannot see it before either has written.
    workspaceLock = await lockWorkspace(realpathSync.native(task.workspace), activeDir);
    if (!workspaceLock) {
      if (!resuming) rmSync(activeDir, { recursive: true, force: true });
      throw new Error('workspace_busy');
    }
    if (resuming) { reap(activeDir); repairLogs(activeDir); }
    const gitFile = resuming ? state.git_file ?? null : gitFileContent(task.workspace);
    trustGit(task.workspace, gitFile);
    const roots: Record<string, string> = resuming ? state.roots ?? {} : Object.fromEntries(
      [task.workspace, ...(task.read_roots ?? [])].map(item => [item, realPath(item)]));
    for (const [item, real] of Object.entries(roots)) trustRoot(item, real);
    result.run_dir = activeDir;
    if (resuming && previous) unlinkSync(path.join(activeDir, 'result.json'));
    const ledgerPath = path.join(activeDir, 'ledger.jsonl');
    if (task.clean_room) {
      const verified = await verifyClean({ ...task, read_roots: task.read_roots ?? [] }, activeDir);
      appendLedger(ledgerPath, { time: new Date().toISOString(), clean_room: verified });
    }
    const start = resuming ? state.start : await gitData(task.workspace,
      activeDir, 'start', '', task.box);
    if (!resuming && start.dirty) throw new Error('Workspace has uncommitted changes');
    if (task.host_jobs && !start.repository) throw new Error('host_jobs needs a git workspace');
    const nextState = state ?? { start, resumes: 0, started_at: new Date().toISOString(), git_file: gitFile, roots };
    if (resuming) nextState.resumes++;
    nextState.pid = process.pid;
    nextState.process_started_at = Date.now() - process.uptime() * 1000;
    atomicJson(stateFile, nextState);
    if (!resuming) atomicJson(path.join(activeDir, 'task.json'), task);
    // Expanded after task.json is written, so a resume expands the same specs once.
    for (const file of task.specs ?? []) {
      task.questions = [...task.questions ?? [], ...specQuestions(task.workspace, file)];
    }
    if (resuming && existsSync(ledgerPath)) {
      const ledger = ledgerUsage(ledgerPath);
      Object.assign(usage, ledger.usage);
      if (ledger.quotaFailure) result.warnings.push('quota_read_failed');
    }
    const mcpTools: ReturnType<McpServer['tool']>[] = [];
    for (const [name, config] of Object.entries(task.mcp ?? {})) {
      if (config.lock) {
        const file = lockPath(`mcp:${config.lock}`); const owner = lockOwner(activeDir, `mcp:${name}`);
        const end = Date.now() + (task.host_queue_timeout_s ?? 7200) * 1000;
        if (!mcpLocks.includes(file)) {
          while (!takeLock(file, owner)) {
            if (Date.now() >= end) throw new Error('mcp_lock_timeout');
            await new Promise(resolve => setTimeout(resolve, Math.min(500, end - Date.now())));
          }
          mcpLocks.push(file);
        }
      }
      let server: McpServer;
      try { server = new McpServer(name, config, activeDir); mcpServers.push(server); }
      catch { throw new Error(`mcp_start_failed: ${name}`); }
      let available: any[];
      try { available = await server.list(); } catch { throw new Error(`mcp_start_failed: ${name}`); }
      for (const tool of config.tools) {
        const def = available.find(item => item.name === tool);
        if (!def) throw new Error(`mcp_missing_tool: ${name} ${tool}`);
        mcpTools.push(server.tool(def));
      }
    }
    const model = modelFor(task.model);
    if (!model || model.contextWindow < 150000) throw new Error('Unsupported model');
    if (!inCatalog(task.model)) result.warnings.push('model_not_in_catalog');
    checkEffort(model, task.effort);
    Object.assign(result, { model: task.model, effort: task.effort, service_tier: task.service_tier ?? 'default' });
    const agentDir = path.resolve(process.env.HARNESS_AGENT_DIR ?? defaultAgentDir);
    const baseUrl = task.base_url ?? model.baseUrl;
    const base = new URL(baseUrl);
    const isTest = base.hostname === '127.0.0.1' || base.hostname === 'localhost' || base.hostname === '[::1]';
    if (task.base_url && !isTest) throw new Error('Test base URL must be loopback');
    let gateError: unknown;
    const effort = resolvedEffort(model, task.effort);
    const parentTools = ['inspect', 'run', 'edit', 'finish', ...(task.roles ? ['delegate'] : []),
      ...(task.host_jobs ? ['host_job'] : []), ...(task.web ? ['web_search',
        ...(task.web.fetch === false ? [] : ['web_fetch'])] : []), ...mcpTools.map(tool => tool.name)];
    const profiles = [{ model: task.model, effort, tools: parentTools }];
    for (const role of Object.values(task.roles ?? {})) {
      const childModel = modelFor(role.model);
      if (childModel && role.effort) checkEffort(childModel, role.effort);
      if (!childModel || !role.effort || !role.tools.every(name => ['inspect', 'run', 'edit',
        'finish', ...(task.web ? ['web_search', ...(task.web.fetch === false ? [] : ['web_fetch'])] : []),
        ...mcpTools.map(tool => tool.name)]
        .includes(name)) || !Number.isFinite(role.max_quota_percent) || role.max_quota_percent < 0) {
        throw new Error('Invalid role');
      }
      const childEffort = resolvedEffort(childModel, role.effort);
      profiles.push({ model: role.model, effort: childEffort, tools: role.tools });
    }
    const quotaCommand = process.env.HARNESS_QUOTA_COMMAND ?? JSON.stringify([process.execPath,
      path.resolve(import.meta.dirname, 'limits.ts')]);
    restore = installGate({ allowedHosts: isTest ? [base.host] : ['api.openai.com', 'auth.openai.com'],
      forbiddenTermsFile: task.forbidden_terms_file, profiles, ledgerPath, cleanRoom: !!task.clean_room,
      maxQuotaPercent: task.max_quota_percent ?? 1, usage, quotaCommand,
      serviceTier: task.service_tier === 'priority' ? 'priority' : undefined,
      onQuotaFailure: () => {
        if (!result.warnings.includes('quota_read_failed')) result.warnings.push('quota_read_failed');
      }, onFailure: error => { gateError = error; } });
    delete process.env.OPENAI_API_KEY;
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
      refreshOnCreate: false });
    if (isTest) {
      if (!process.env.HARNESS_TEST_API_KEY) throw new Error('Test key required');
      await runtime.setRuntimeApiKey('openai', process.env.HARNESS_TEST_API_KEY);
    }
    const loader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => prompt(task.box, !!task.web, !!task.mcp), getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {},
      reload: async () => {},
    };
    let session: Awaited<ReturnType<typeof createSession>>['session'];
    if (task.max_run_s !== undefined && (!Number.isFinite(task.max_run_s) || task.max_run_s <= 0)) {
      throw new Error('Invalid max_run_s');
    }
    let finish: { state: 'done' | 'blocked'; summary: string; answers?: Answer[] } | undefined;
    const web = task.web ? createWeb(task.web, activeDir, task.forbidden_terms_file) : undefined;
    const customTools = createTools({ workspace: task.workspace, readRoots: task.read_roots ?? [], web,
      webFetch: task.web?.fetch !== false, noImages: !!task.clean_room,
      runDir: activeDir, box: task.box, env: task.env, path: task.path, maxRunS: task.max_run_s,
      hostJob: task.host_jobs ? (id, args) => hostJob(task, activeDir, id, args) : undefined,
      hostJobSpecs: task.host_jobs && Object.fromEntries(Object.entries(task.host_jobs).map(([id, job]) =>
        [id, job.args ?? {}])),
      finish: (state, summary, answers) => { finish = { state,
      summary, answers }; void session.abort(); } });
    if (task.roles) customTools.push(delegate({ task, usage, runDir: activeDir, agentDir, baseUrl, runtime,
      loader, flush: restore.flush, web, mcpTools }));
    const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', retry: retrySettings(),
      compaction: { enabled: true, reserveTokens: model.contextWindow - 150000 } });
    const sessionDir = path.join(activeDir, 'session');
    const sessionManager = resuming ? SessionManager.continueRecent(task.workspace,
      sessionDir) : SessionManager.create(task.workspace, sessionDir);
    ({ session } = await createSession({ cwd: task.workspace, agentDir, modelRuntime: runtime,
      resourceLoader: loader, tools: parentTools, customTools: [...customTools, ...mcpTools], sessionManager,
      settingsManager }, model, task.effort, baseUrl));
    session.subscribe(event => {
      if (event.type === 'auto_retry_start' && gateError) queueMicrotask(() => session.abortRetry());
    });
    try {
      appendLedger(ledgerPath, { time: new Date().toISOString(), requested_effort: task.effort,
        resolved_effort: session.thinkingLevel });
      if (session.thinkingLevel !== task.effort) throw new Error('Thinking level changed');
      const remaining = [...(task.acceptance ?? [])
        .filter(check => !previous?.checks?.some(item => item.id === check.id && item.status === 'passed'))
        .map(check => check.id), ...(task.questions ?? []).map(question => question.id)].join(', ') || 'なし';
      // A CLI stopped before its first reply was saved leaves an empty conversation, so that resume sends the goal.
      const note = resumeNote ? `\n${resumeNote}` : '';
      const message = resuming && session.messages.length
        ? `前回 status が ${previous?.status ?? 'interrupted'} で止まった。残っている条件は ${remaining}${note}` : undefined;
      if (!message) task.goal += note;
      await runLoop(session, task, activeDir, result, () => finish, () => { finish = undefined; },
        start.repository ? start.head : null, restore.flush, () => { if (gateError) throw gateError; }, message);
    } finally { session.dispose(); }
  } catch (error) {
    result.status = error instanceof BudgetExhausted ||
      (error instanceof Error && error.message.includes('subscription_sharing_usage_limit_exceeded'))
      ? 'budget_exhausted'
      : error instanceof GateBlocked || error instanceof CleanBlocked ? 'quarantined' : 'failed';
    result.reason = (error instanceof Error ? error.message : 'Unknown error')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]').slice(0, 300);
    if (result.reason.includes('subscription_sharing_usage_limit_exceeded')) result.reason = 'account_limit';
    result.summary = '';
  } finally {
    for (const server of mcpServers) await server.close();
    for (const file of mcpLocks) removeLock(file);
    await restore?.flush();
    restore?.();
    if (result.run_dir) {
      try { atomicJson(path.join(result.run_dir, 'result.json'), result);
        } catch { result.status = 'failed'; }
    }
    if (workspaceLock) removeLock(workspaceLock);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status !== 'completed') process.exitCode = 1;
  }
}
try {
  if (process.argv[2] === 'mcp-tools') {
    if (process.argv.length !== 4) throw new Error('Invalid mcp-tools arguments');
    const task: unknown = JSON.parse(readFileSync(process.argv[3], 'utf8')); validateTask(task);
    if (task.mcp && task.clean_room) throw new CleanBlocked('mcp is not allowed in a clean room');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-'));
    try {
      for (const [name, config] of Object.entries(task.mcp ?? {})) {
        // Only reads names, so it does not join the line for the lock.
        let server: McpServer | undefined;
        try {
          server = new McpServer(name, config, dir);
          for (const tool of await server.list()) process.stdout.write(JSON.stringify({ server: name, tool: tool.name,
            description: String(tool.description ?? '').slice(0, 200) }) + '\n');
        } catch { throw new Error(`mcp_start_failed: ${name}`); }
        finally { await server?.close(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  else if (process.argv[2] === 'login') await login();
  else if (process.argv[2] === 'clean-copy') {
    try {
      if (process.argv.length !== 4) throw new Error('Invalid clean-copy arguments');
      const result = cleanCopy(process.argv[3]);
      process.stdout.write(JSON.stringify(result) + '\n');
      if ('status' in result && result.status === 'quarantined') process.exitCode = 1;
    } catch (error) {
      const reason = error instanceof CleanFailure ? error.message : 'clean-copy failed';
      process.stdout.write(JSON.stringify({ status: 'failed', reason }) + '\n');
      process.exitCode = 1;
    }
  }
  else if (process.argv[2] === 'audit' || process.argv[2] === 'export') {
    const isAudit = process.argv[2] === 'audit';
    if (process.argv.length !== (isAudit ? 4 : 5)) throw new Error('Invalid arguments');
    const result = isAudit ? audit(path.resolve(process.argv[3])) :
      exportPatch(path.resolve(process.argv[3]), path.resolve(process.argv[4]));
    process.stdout.write(JSON.stringify(result) + '\n');
    if ('ok' in result && !result.ok) process.exitCode = 1;
  }
  else if (!command(process.argv.slice(2))) await main();
} catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1; }
