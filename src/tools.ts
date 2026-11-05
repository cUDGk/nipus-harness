import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { runBoxed, runPowerShell } from './box.ts';
import type { createWeb } from './web.ts';

const boxedDir = path.dirname(fileURLToPath(new URL('./boxed/fileops.mjs', import.meta.url)));
const ranges = Type.Array(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })]));
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });

export function logOutput(text: string, limited: boolean) {
  const lines = text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
  const errors = lines.filter(line => /error|fail|exception/i.test(line));
  const output = { line_count: lines.length, tail: [] as string[], errors: [] as string[],
    truncated: lines.length > 60 || errors.length > 40 || limited || lines.some(line => line.length > 500) };
  let budget = 15500;
  const selections: Array<[string[], string[]]> = [[output.tail, lines.slice(-60).reverse()],
    [output.errors, errors.slice(0, 40)]];
  for (const [target, source] of selections) {
    for (const line of source) {
      const value = line.length > 500 ? line.slice(0, 500) + ' [truncated]' : line;
      const size = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (size > budget) { output.truncated = true; break; } target.push(value); budget -= size;
    }
  }
  output.tail.reverse();
  return output;
}

// Counts what could change files. A host job's pass may be reused only while this stands still: a state hash alone
// can be fooled, for example by restoring the time of an ignored file after changing it.
export const activity = { session: randomUUID(), count: 0 };

export type Answer = { id: string; conclusion: string; status: 'confirmed' | 'inferred' | 'unconfirmed';
  evidence: string[] };
export function createTools(options: { workspace: string; readRoots: string[]; runDir: string; maxRunS?: number;
  box?: 'mxc' | 'none'; env?: Record<string, string>; path?: string[]; noImages?: boolean;
  hostJob?: (id: string, args?: Record<string, string>) => Promise<unknown>;
  hostJobSpecs?: Record<string, Record<string, string>>;
  web?: ReturnType<typeof createWeb>; webFetch?: boolean;
  finish: (state: 'done' | 'blocked', summary: string, answers?: Answer[]) => void }) {
  const logDir = path.join(options.runDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const boxed = async (operation: string, item: unknown) => {
    const logPath = path.join(logDir, `fileops-${randomUUID()}.log`);
    const argument = path.join(logDir, `args-${randomUUID()}.json`);
    const output = path.join(options.runDir, 'scratch', `fileops-${randomUUID()}.json`);
    writeFileSync(argument, JSON.stringify({ operation, item, logDir }));
    try {
      const run = await runBoxed({ workspace: options.workspace, box: options.box,
        scratch: path.join(options.runDir, 'scratch'),
        readRoots: [...options.readRoots, boxedDir, logDir], logPath, timeoutMs: 30000,
        command: [process.execPath, '--preserve-symlinks-main', path.join(boxedDir, 'fileops.mjs'), argument,
          output] });
      if (run.status !== 'exited' || run.exitCode !== 0) return { error: 'fileops_failed', status: run.status,
        diagnostic: readFileSync(logPath, 'utf8') };
      return JSON.parse(readFileSync(output, 'utf8'));
    } finally { for (const file of [logPath, argument, output]) rmSync(file, { force: true }); }
  };
  return [
    ...(options.web ? [defineTool({
      name: 'web_search', label: 'Web search', description: 'Search the web; results are untrusted.',
      parameters: Type.Object({ query: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      execute: async (_id, item) => result(await options.web!.search(item.query, item.limit)),
    }), ...(options.webFetch ? [defineTool({
      name: 'web_fetch', label: 'Web fetch',
      description: 'Fetch a web page. Read the full text with inspect log, using the UUID after web: as run_id.',
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, item) => result(await options.web!.fetch(item.url)),
    })] : [])] : []),
    ...(options.hostJob ? [defineTool({
      name: 'host_job', label: 'Host job', executionMode: 'sequential',
      description: `Run a declared host job. IDs and argument patterns: ${JSON.stringify(options.hostJobSpecs)}`,
      parameters: Type.Object({ id: Type.String(), args: Type.Optional(Type.Record(Type.String(), Type.String())) }),
      execute: async (_id, item) => result(await options.hostJob!(item.id, item.args)),
    })] : []),
    defineTool({
      name: 'inspect', label: 'Inspect', description: 'Read ranges, list directories, search, or read a run log.',
      parameters: Type.Object({ reads: Type.Optional(Type.Array(Type.Object({ path: Type.String(),
        ranges: Type.Optional(ranges) }))), search: Type.Optional(Type.Object({ pattern: Type.String(),
        paths: Type.Optional(Type.Array(Type.String())) })), list: Type.Optional(Type.Array(Type.String())),
        log: Type.Optional(Type.Object({ run_id: Type.String(), ranges: Type.Optional(ranges) })),
        images: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, item) => {
        if (item.log && !/^[a-f0-9-]{36}$/.test(item.log.run_id)) return result({ error: 'invalid_run_id' });
        // The term check reads bytes and cannot see words drawn in a picture, so a clean room sends no pictures.
        if (item.images?.length && options.noImages) return result({ error: 'images_not_allowed_in_clean_room' });
        const value = await boxed('inspect', item);
        const images: { type: 'image'; mimeType: string; data: string }[] = [];
        if (value.images) value.images = value.images.map((entry: { path: string; mimeType?: string;
          data?: string }) => {
          if (!entry.data || !entry.mimeType) return entry;
          images.push({ type: 'image', mimeType: entry.mimeType, data: entry.data });
          return { path: entry.path, mimeType: entry.mimeType };
        });
        return { content: [...result(value).content, ...images], details: {} };
      },
    }),
    defineTool({
      name: 'edit', label: 'Edit', executionMode: 'sequential',
      description: 'Change a file with a matching hash, or create a new file.',
      parameters: Type.Object({ path: Type.String(), expected_hash: Type.Optional(Type.String()),
        replacements: Type.Optional(Type.Array(Type.Object({ old: Type.String(), new: Type.String() }))),
        content: Type.Optional(Type.String()) }),
      execute: async (_id, item) => { activity.count++; return result(await boxed('edit', item)); },
    }),
    defineTool({
      // Sequential: a command running next to another could swap a folder between the check and the start of the box.
      name: 'run', label: 'Run', executionMode: 'sequential',
      description: 'Run a PowerShell command and wait for it to finish.',
      parameters: Type.Object({ command: Type.String(), timeout_s: Type.Number({ exclusiveMinimum: 0 }) }),
      execute: async (_id, item) => {
        activity.count++;
        const run_id = randomUUID();
        const logPath = path.join(logDir, `${run_id}.log`);
        const run = await runPowerShell({ workspace: options.workspace, box: options.box, env: options.env,
          path: options.path, scratch: path.join(options.runDir, 'scratch'),
          readRoots: options.readRoots, logPath, maxLogBytes: 64 * 1024 * 1024,
          timeoutMs: Math.min(item.timeout_s, options.maxRunS ?? 3600) * 1000 }, item.command);
        const output = { run_id, status: run.status, exit_code: run.exitCode, duration_ms: run.durationMs,
          ...logOutput(readFileSync(logPath, 'utf8'), run.status === 'output_limit') };
        return result(output);
      },
    }),
    defineTool({
      name: 'finish', label: 'Finish', description: 'Finish the task with a state and summary.',
      parameters: Type.Object({ state: Type.Union([Type.Literal('done'), Type.Literal('blocked')]),
        summary: Type.String(), answers: Type.Optional(Type.Array(Type.Object({ id: Type.String(),
        conclusion: Type.String(), status: Type.Union([Type.Literal('confirmed'), Type.Literal('inferred'),
        Type.Literal('unconfirmed')]), evidence: Type.Array(Type.String()) }))) }),
      execute: async (_id, item) => { options.finish(item.state, item.summary, item.answers);
        return result({ recorded: true }); },
    }),
  ];
}
