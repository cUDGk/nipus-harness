import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { onPath } from './boxed/which.mjs';
import { secretEnvironment } from './box.ts';
import { activity, logOutput } from './tools.ts';
import { appendLedger } from './gate.ts';

export type McpConfig = { command: string[]; tools: string[]; env?: Record<string, string>;
  timeout_s?: number; start_timeout_s?: number; lock?: string };

const maxLine = 64 * 1024 * 1024;
const maxLog = 16 * 1024 * 1024;
const maxImage = 20 * 1024 * 1024;
const maxTools = 5000;
class CallTimeout extends Error {}
class ServerError extends Error {}

// The SDK tests a schema's patterns on the worker's arguments with no time limit, and a bad pattern can take for ever.
// The server checks its own arguments anyway. Directly under properties a key is a name, so "pattern" stays there.
function withoutPatterns(schema: unknown, naming = false): unknown {
  if (Array.isArray(schema)) return schema.map(item => withoutPatterns(item));
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key, value]) => naming || !(key === 'patternProperties' || (key === 'pattern' && typeof value === 'string')))
    .map(([key, value]) => [key, withoutPatterns(value, !naming && key === 'properties')]));
}

// One MCP server over stdio: JSON-RPC 2.0, one message per line. It runs outside the box as the user, which is why a
// task names each tool it may use.
export class McpServer {
  child: ChildProcessWithoutNullStreams;
  exitCode: number | null = null;
  exited = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private next = 0;
  private buffer = Buffer.alloc(0);
  private logBytes = 0;
  private log: string;
  name: string; config: McpConfig; runDir: string;
  constructor(name: string, config: McpConfig, runDir: string) {
    this.name = name; this.config = config; this.runDir = runDir;
    const cwd = path.join(runDir, 'mcp', name); mkdirSync(cwd, { recursive: true });
    mkdirSync(path.join(runDir, 'logs'), { recursive: true });
    this.log = path.join(runDir, 'logs', `mcp-${name}.log`);
    try { this.logBytes = statSync(this.log).size; } catch { /* No log yet. */ }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!secretEnvironment.test(key)) env[key] = value;
    Object.assign(env, config.env, { NoDefaultCurrentDirectoryInExePath: '1' });
    this.child = spawn(onPath(config.command[0]), config.command.slice(1), { cwd, env, shell: false, windowsHide: true });
    // A later reap finds the server by this, because a server's command line does not name the run.
    if (this.child.pid) writeFileSync(path.join(cwd, 'process.json'),
      JSON.stringify({ pid: this.child.pid, started_at: Date.now() }));
    this.child.stderr.on('data', (data: Buffer) => this.logData(data));
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    this.child.stdin.on('error', () => { /* Seen as the exit of the server. */ });
    this.child.on('error', () => this.dead(null));
    this.child.on('exit', code => this.dead(code));
  }
  private logData(data: Buffer) {
    const part = data.subarray(0, Math.max(0, maxLog - this.logBytes));
    if (part.length) { appendFileSync(this.log, part); this.logBytes += part.length; }
  }
  private dead(code: number | null) {
    if (this.exited) return;
    this.exited = true; this.exitCode = code;
    for (const item of this.pending.values()) item.reject(new Error('server_exited'));
    this.pending.clear();
  }
  private send(value: object) {
    if (!this.exited && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private receive(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end > maxLine || (end < 0 && this.buffer.length > maxLine)) { this.dead(null); this.child.kill(); return; }
      if (end < 0) return;
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      let message: any;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { this.logData(Buffer.concat([line, Buffer.from('\n')])); continue; }
      // A request from the server numbers its ids on its own, so one can equal an id of ours.
      if (message?.method) {
        if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping'
          ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }) });
        continue;
      }
      const item = this.pending.get(message?.id);
      if (!item) continue;
      this.pending.delete(message.id);
      if (message.error) item.reject(new ServerError(typeof message.error.message === 'string'
        ? message.error.message.slice(0, 2000) : 'rpc_error'));
      else item.resolve(message.result);
    }
  }
  private async request(method: string, params: unknown, timeout: number) {
    if (this.exited) throw new Error('server_exited');
    const id = ++this.next;
    let timer: NodeJS.Timeout;
    const reply = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } });
        reject(new CallTimeout());
      }, timeout);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
    try { return await reply; } finally { clearTimeout(timer!); }
  }
  async list() {
    const end = Date.now() + (this.config.start_timeout_s ?? 60) * 1000;
    const request = (method: string, params: unknown) => this.request(method, params, Math.max(1, end - Date.now()));
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'Nipus-harness', version: '1' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools: any[] = []; let cursor: string | undefined;
    do {
      const page = await request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page.tools) || tools.length + page.tools.length > maxTools) throw new Error('bad_tool_list');
      tools.push(...page.tools); cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
  async close() {
    const record = path.join(this.runDir, 'mcp', this.name, 'process.json');
    // Stopped as a tree while the server is alive: once it has exited, the helpers it started can no longer be found.
    if (!this.exited && this.child.pid) {
      const gone = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5000);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      const killer = spawn(onPath('taskkill.exe'), ['/PID', String(this.child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' });
      await new Promise<void>(resolve => { killer.on('error', () => resolve()); killer.on('close', () => resolve()); });
      await gone;
    }
    if (this.exited) rmSync(record, { force: true });
  }
  private reply(result: any) {
    let text = ''; let images = 0;
    const parts: any[] = [];
    for (const item of result.content ?? []) {
      if (item.type === 'text') text += item.text;
      else if (item.type !== 'image') parts.push({ type: 'text', text: JSON.stringify({ unsupported_content: item.type }) });
      else if (/^image\/(png|jpeg|webp|gif)$/.test(item.mimeType) && typeof item.data === 'string' &&
        item.data.length <= maxImage && item.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) {
        parts.push({ type: 'image', mimeType: item.mimeType, data: item.data }); images++;
      } else parts.push({ type: 'text', text: JSON.stringify({ omitted_image: item.mimeType }) });
    }
    let value: string | object = text;
    if (Buffer.byteLength(text) > 15500) {
      const run_id = randomUUID();
      writeFileSync(path.join(this.runDir, 'logs', `${run_id}.log`), text);
      value = { run_id, ...logOutput(text, true) };
    }
    if (result.isError) value = { error: 'mcp_tool_error', result: value };
    // A reply of only a picture still needs words: a tool result with empty text is not a useful message.
    const first = typeof value === 'string' ? value || JSON.stringify({ images }) : JSON.stringify(value);
    return { parts: [{ type: 'text', text: first }, ...parts], text, images, isError: !!result.isError };
  }
  tool(def: any) {
    return defineTool({ name: `mcp__${this.name}__${def.name}`, label: def.name,
      description: String(def.description ?? '').slice(0, 1000), executionMode: 'sequential',
      parameters: Type.Unsafe((def.inputSchema?.type ? withoutPatterns(def.inputSchema) :
        { type: 'object', properties: {} }) as object),
      execute: async (_id, args) => {
        activity.count++; // It may change files, so a host job's earlier pass no longer holds.
        const started = Date.now();
        let status = 'ok'; let bytes = 0; let images = 0; let content: any[];
        try {
          const reply = this.reply(await this.request('tools/call', { name: def.name, arguments: args },
            (this.config.timeout_s ?? 120) * 1000));
          content = reply.parts; bytes = Buffer.byteLength(reply.text); images = reply.images;
          if (reply.isError) status = 'tool_error';
        } catch (error) {
          status = error instanceof CallTimeout ? 'timeout' : this.exited ? 'server_exited' : 'error';
          content = [{ type: 'text', text: JSON.stringify(status === 'timeout' ? { error: 'mcp_timeout' }
            : status === 'server_exited' ? { error: 'mcp_server_exited', exit_code: this.exitCode }
              : { error: 'mcp_tool_error', message: error instanceof ServerError ? error.message : 'call_failed' }) }];
        }
        // Arguments and results stay out of the ledger: they can hold anything the tool touches.
        appendLedger(path.join(this.runDir, 'ledger.jsonl'), { time: new Date().toISOString(), mcp: { server: this.name,
          tool: def.name, ms: Date.now() - started, status, text_bytes: bytes, images,
          args_sha256: createHash('sha256').update(JSON.stringify(args)).digest('hex') } });
        return { content, details: {} };
      } });
  }
}
