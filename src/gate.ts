import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync,
  writeSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readTerms, scanValue } from './scan.ts';
import { onPath } from './boxed/which.mjs';

export type Usage = { calls: number; input: number; cached: number; output: number; reasoning: number;
  quota_percent: number };
export const roleContext = new AsyncLocalStorage<{ name: string; usage: Usage; aggregate: Usage; limit: number;
  error?: unknown; globalExhausted?: boolean }>();

export class GateBlocked extends Error {
  readonly reason: 'forbidden_term' | 'model_mismatch' | 'tool_not_declared' | 'image_in_clean_room';
  constructor(reason: GateBlocked['reason']) {
    super(reason);
    this.reason = reason;
  }
}
export class BudgetExhausted extends Error {
  constructor(reason = 'budget_exhausted') { super(reason); }
}

// What one token weighs against the week's quota, relative to gpt-6.1-terra, whose shares were measured (kb
// k20261102-2deb7c). The others follow the official prices per token, and astra also fits its own measurement (kb
// k20261102-474635). An unknown model counts as the dearest, so a budget stops too early rather than too late. The
// fast tier costs twice the tokens in the official price table; what it costs the plan has not been measured.
const modelWeight: Record<string, number> = { 'gpt-6.1-terra': 1, 'gpt-6-luna': 0.1, 'gpt-6-sol': 2, 'gpt-6.1-sol': 2,
  'gpt-6-astra': 10 };
export const quotaOf = (item: { input: number; cached: number; output: number }, weight = 1) =>
  (item.cached / 150000000 + item.input / 9300000 + item.output / 1000000) * weight;

export interface GateConfig {
  allowedHosts: string[];
  forbiddenTermsFile?: string | null;
  model?: string;
  effort?: string;
  tools?: string[];
  profiles?: { model: string; effort: string | undefined; tools: string[] }[];
  ledgerPath: string;
  cleanRoom?: boolean;
  maxQuotaPercent: number;
  quotaPercent?: () => number;
  usage?: { calls: number; input: number; cached: number; output: number; reasoning: number; quota_percent: number };
  onFailure?: (error: unknown) => void;
  quotaCommand?: string;
  serviceTier?: 'priority';
  onQuotaFailure?: () => void;
}

export function appendLedger(file: string, entry: object): void {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, JSON.stringify(entry) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function installGate(config: GateConfig): (() => void) & { flush: () => Promise<void> } {
  const terms = config.forbiddenTermsFile
    ? readTerms(readFileSync(config.forbiddenTermsFile, 'utf8'))
    : [];
  const originalFetch = globalThis.fetch;
  let requestNumber = config.cleanRoom && existsSync(config.ledgerPath)
    ? readFileSync(config.ledgerPath, 'utf8').split('\n').filter(Boolean).reduce((max, line) =>
      Math.max(max, JSON.parse(line).request_number ?? 0), 0) : 0;
  // A copy with no ledger row was left by a crash between the two writes. The row comes before the send, so that
  // request never left this PC and its number is free again.
  const copies = path.join(path.dirname(config.ledgerPath), 'requests');
  if (config.cleanRoom && existsSync(copies)) {
    for (const name of readdirSync(copies)) {
      if (Number.parseInt(name, 10) > requestNumber) rmSync(path.join(copies, name), { force: true });
    }
  }
  const originalWebSocket = globalThis.WebSocket;
  const pending = new Set<Promise<void>>();
  let quotaAt = 0;
  let accountLimit: BudgetExhausted | undefined;
  let providerFailure: Error | undefined;
  const markAccountLimit = () => {
    accountLimit ??= new BudgetExhausted('account_limit');
    const role = roleContext.getStore();
    if (role) { role.error = accountLimit; role.globalExhausted = true; }
    config.onFailure?.(accountLimit);
  };
  const inspectFailure = (body: string) => {
    if (body.includes('subscription_sharing_usage_limit_exceeded')) { markAccountLimit(); return; }
    if (/subscription_sharing_(user_not_eligible|unsupported_capability|route_not_supported|invalid_user)/.test(body)) {
      providerFailure ??= new Error(`Model request failed: ${body}`);
      const role = roleContext.getStore();
      if (role) role.error = providerFailure;
      config.onFailure?.(providerFailure);
    }
  };
  let quotaValue: number | undefined;
  let quotaPending: Promise<void> | undefined;
  const checkQuota = async () => {
    if (!config.quotaCommand) return;
    if (!quotaPending && Date.now() - quotaAt >= 60000) {
      quotaAt = Date.now();
      quotaPending = (async () => {
        try {
          const args: unknown = JSON.parse(config.quotaCommand!);
          if (!Array.isArray(args) || !args.length || !args.every(s => typeof s === 'string' && s)) {
            throw new Error('Invalid quota command');
          }
          const { stdout } = await promisify(execFile)(onPath(args[0]), args.slice(1), { timeout: 30000 });
          const value = JSON.parse(stdout).rateLimits.primary.usedPercent;
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid quota');
          quotaValue = value;
        } catch {
          quotaValue = undefined;
          appendLedger(config.ledgerPath, { time: new Date().toISOString(), quota_read_failed: true });
          config.onQuotaFailure?.();
        }
      })().finally(() => { quotaPending = undefined; });
    }
    await quotaPending;
    if (quotaValue !== undefined && quotaValue >= 99) throw new BudgetExhausted('account_limit');
  };
  const flush = async () => { await Promise.all([...pending]); };
  globalThis.fetch = async (input, init) => {
    try {
    const role = roleContext.getStore();
    let request = new Request(input, init);
    const url = new URL(request.url);
    let weight = 1;
    if (!config.allowedHosts.includes(url.host)) throw new Error('Host not allowed');
    if (request.method.toUpperCase() === 'POST' && url.pathname.endsWith('/responses')) {
      await flush();
      if (accountLimit) throw accountLimit;
      if (providerFailure) throw providerFailure;
      await checkQuota();
      let bytes = Buffer.from(await request.clone().arrayBuffer());
      let parsed: { model?: string; reasoning?: { effort?: string }; tools?: Array<{ type?: string; name?: string }>;
        service_tier?: string };
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new GateBlocked('model_mismatch'); }
      // Only the task decides the tier, for every request of the run, so fast mode cannot come or go on its own.
      if (parsed.service_tier !== config.serviceTier) {
        if (config.serviceTier) parsed.service_tier = config.serviceTier; else delete parsed.service_tier;
        bytes = Buffer.from(JSON.stringify(parsed));
        request = new Request(request, { body: bytes });
      }
      weight = (modelWeight[parsed.model ?? ''] ?? 10) * (config.serviceTier ? 2 : 1);
      const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
        : Array.isArray(value) ? value.flatMap(strings)
          : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
            : [];
      if (strings(parsed).some(value => scanValue(value, terms).length)) {
        throw new GateBlocked('forbidden_term');
      }
      // Words drawn in a picture cannot be checked, so a clean room sends none.
      if (config.cleanRoom && strings(parsed).some(value => value.startsWith('data:image/'))) {
        throw new GateBlocked('image_in_clean_room');
      }
      const profiles = config.profiles ?? [{ model: config.model, effort: config.effort, tools: config.tools ?? [] }];
      const profile = profiles.find(item => parsed && parsed.model === item.model &&
        parsed.reasoning?.effort === item.effort);
      if (!profile) throw new GateBlocked('model_mismatch');
      const validTools = (value: unknown): value is Array<{ type: string;
        name: string }> => Array.isArray(value) && value.every(tool => tool && tool.type === 'function' &&
          typeof tool.name === 'string' && profile.tools.includes(tool.name));
      const additional = (parsed as { input?: unknown }).input;
      const embedded = Array.isArray(additional)
        ? additional.filter(item => item && item.type === 'additional_tools').map(item => item.tools) : [];
      if ((parsed.tools !== undefined && !validTools(parsed.tools)) || embedded.some(tools => !validTools(tools))) {
        throw new GateBlocked('tool_not_declared');
      }
      if ((config.usage?.quota_percent ?? config.quotaPercent?.() ?? 0) > config.maxQuotaPercent) {
        if (role) role.globalExhausted = true;
        throw new BudgetExhausted();
      }
      if (role && role.usage.quota_percent > role.limit) throw new BudgetExhausted();
      let number: number | undefined;
      let compressedHash: string | undefined;
      if (config.cleanRoom) {
        number = ++requestNumber;
        const dir = path.join(path.dirname(config.ledgerPath), 'requests'); mkdirSync(dir, { recursive: true });
        const compressed = gzipSync(bytes);
        const fd = openSync(path.join(dir, `${number}.json.gz`), 'wx');
        try { writeFileSync(fd, compressed); fsyncSync(fd); } finally { closeSync(fd); }
        compressedHash = createHash('sha256').update(compressed).digest('hex');
      }
      appendLedger(config.ledgerPath, { time: new Date().toISOString(), request_number: number,
        gzip_sha256: compressedHash,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, model: parsed.model,
        effort: parsed.reasoning?.effort ?? null, service_tier: config.serviceTier ?? 'default',
        tools: [...(parsed.tools ?? []),
        ...embedded.flat()].map(tool => tool.name) });
    } else {
      appendLedger(config.ledgerPath, { time: new Date().toISOString(), path: url.pathname });
    }
    const response = await originalFetch(request);
    if (request.method.toUpperCase() !== 'POST' || !url.pathname.endsWith('/responses')) return response;
    if (!response.ok) inspectFailure(await response.clone().text());
    if (!response.body) {
      try { appendLedger(config.ledgerPath, { time: new Date().toISOString(), usage: null }); }
      catch { /* Usage monitoring must not interrupt the response. */ }
      return response;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let recorded = false;
    const record = (value?: { input_tokens?: number; output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }) => {
      if (recorded) return;
      recorded = true;
      const cached = value?.input_tokens_details?.cached_tokens ?? 0;
      const item = value ? { input: Math.max(0, (value.input_tokens ?? 0) - cached), cached,
        output: value.output_tokens ?? 0, reasoning: value.output_tokens_details?.reasoning_tokens ?? 0 } : null;
      const quota = item ? quotaOf(item, weight) : 0;
      if (item) for (const target of [config.usage, role?.usage, role?.aggregate]) {
        if (!target) continue;
        target.calls++; target.input += item.input; target.cached += item.cached;
        target.output += item.output; target.reasoning += item.reasoning;
        target.quota_percent += quota;
      }
      try {
        appendLedger(config.ledgerPath, { time: new Date().toISOString(), usage: item, quota, role: role?.name });
      }
      catch { /* Usage monitoring must not interrupt the response. */ }
    };
    const [caller, monitor] = response.body.tee();
    const observed = (async () => {
      try {
        for await (const chunk of monitor) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
          for (const line of lines) if (line.startsWith('data:')) {
            try {
              const event = JSON.parse(line.slice(5));
              if (event.type === 'response.failed') inspectFailure(JSON.stringify(event));
              // An incomplete response ran into a limit, and its tokens were spent all the same.
              if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
                record(event.response?.usage);
              }
            } catch { /* Ignore non-JSON SSE lines. */ }
          }
        }
      } catch { /* A failed monitor must not alter the caller's stream. */ }
      finally { record(); }
    })();
    pending.add(observed);
    void observed.finally(() => pending.delete(observed));
    return new Response(caller, { status: response.status, statusText: response.statusText,
      headers: response.headers });
    } catch (error) {
      const role = roleContext.getStore();
      if (role && (error instanceof BudgetExhausted || error instanceof GateBlocked)) role.error = error;
      if (error instanceof GateBlocked || (error instanceof BudgetExhausted && (!role || role.globalExhausted))) {
        config.onFailure?.(error);
      }
      throw error;
    }
  };
  globalThis.WebSocket = class { constructor() { throw new Error('WebSocket disabled');
    } } as unknown as typeof WebSocket;
  const restore = () => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket; };
  return Object.assign(restore, { flush });
}
