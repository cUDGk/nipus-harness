import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { machineSetting } from './box.ts';
import { appendLedger } from './gate.ts';
import { readTerms, scanText } from './scan.ts';

export type WebConfig = { search_url?: string; fetch?: boolean; max_requests?: number; allow_unboxed?: boolean };

// The search server depends on the machine: the task's search_url, then HARNESS_SEARCH_URL, then harness.json.
export function searchUrl(config: WebConfig) {
  const value = config.search_url ?? process.env.HARNESS_SEARCH_URL ?? machineSetting('search_url');
  if (!value) throw new Error('No search server: set search_url in web, or HARNESS_SEARCH_URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid search_url'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid search_url');
  return url;
}

type Lookup = typeof dns.lookup;
type Options = { lookup?: Lookup; allowLoopback?: boolean };
const blocked = new net.BlockList();
for (const [address, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, bits, 'ipv4');
for (const [address, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8]] as const) blocked.addSubnet(address, bits, 'ipv6');

function publicAddress(address: string, allowLoopback = false) {
  const family = net.isIP(address);
  if (!family) return false;
  if (allowLoopback && (address === '127.0.0.1' || address === '::1')) return true;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
function checkedUrl(value: string, options: Options) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port) && !options.allowLoopback)) throw new Error('invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !publicAddress(host, options.allowLoopback)) throw new Error('blocked_address');
  return url;
}
function safeLookup(options: Options): Lookup {
  return ((host: string, opts: any, callback: any) => {
    (options.lookup ?? dns.lookup)(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some(a => !publicAddress(a.address, options.allowLoopback))) {
        return callback(new Error('blocked_address'));
      }
      const selected = opts.family ? addresses.filter(a => a.family === opts.family) : addresses;
      if (!selected.length) return callback(new Error('no_address'));
      return opts.all ? callback(null, selected) : callback(null, selected[0].address, selected[0].family);
    });
  }) as Lookup;
}
function request(url: URL, timeout: number, lookup?: Lookup) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { lookup, agent: false,
      headers: { 'user-agent': 'Nipus-harness/1.0', 'accept-encoding': 'gzip, deflate, br' } }, resolve);
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeout);
    // Node closes the socket without a response on a 101 reply, so a close must end the wait as well.
    req.on('close', () => { clearTimeout(timer); reject(new Error('connection closed')); }); req.on('error', reject);
  });
}
async function body(response: http.IncomingMessage, limit: number) {
  const encoding = response.headers['content-encoding']?.toLowerCase();
  const inflate = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() :
    encoding === 'br' ? createBrotliDecompress() : undefined;
  // pipeline passes a lost connection on to the decompressor. With pipe the loop below would wait forever.
  const stream = inflate ? pipeline(response, inflate, () => {}) : response;
  const chunks: Buffer[] = []; let size = 0; let truncated = false;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); const remaining = limit - size;
    chunks.push(bytes.subarray(0, remaining)); size += Math.min(bytes.length, remaining);
    if (bytes.length > remaining) { truncated = true; stream.destroy(); response.destroy(); break; }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}
const hiddenTags = new Set(['script', 'style', 'noscript', 'svg', 'head']);
const blockTag = /^\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\b/i;

// One pass over the page. Pages are not trusted, and a regular expression over a whole page takes hours on "<p<p<p...".
function stripTags(value: string) {
  let out = ''; let at = 0;
  while (at < value.length) {
    const open = value.indexOf('<', at);
    if (open < 0) { out += value.slice(at); break; }
    out += value.slice(at, open);
    if (value.startsWith('<!--', open)) {
      const end = value.indexOf('-->', open + 4);
      if (end < 0) break;
      at = end + 3; continue;
    }
    // "a < b" in text is not a tag.
    if (!/[a-z/!?]/i.test(value[open + 1] ?? '')) { out += '<'; at = open + 1; continue; }
    const close = value.indexOf('>', open);
    if (close < 0) break;
    const tag = value.slice(open + 1, close);
    const name = /^[a-z0-9]+/i.exec(tag)?.[0].toLowerCase();
    if (name && hiddenTags.has(name) && !tag.endsWith('/')) {
      const ending = new RegExp(`</${name}\\s*>`, 'gi');
      ending.lastIndex = close;
      const match = ending.exec(value);
      if (!match) break;
      at = match.index + match[0].length; continue;
    }
    if (blockTag.test(tag)) out += '\n';
    at = close + 1;
  }
  return out;
}

function htmlText(value: string) {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…' };
  return stripTags(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] !== '#') return entities[name.toLowerCase()] ?? match;
      const n = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    }).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}
function decode(bytes: Buffer, type: string) {
  const header = /charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1];
  // HTML requires this tag in the first bytes of a page. Searching a whole page takes hours on "<meta <meta <meta ...".
  const meta = /<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1];
  let text: string;
  try { text = new TextDecoder(header ?? meta ?? 'utf-8').decode(bytes); }
  catch { text = new TextDecoder('utf-8').decode(bytes); }
  return text;
}
// inspect cuts a line at 500 characters, which would lose the rest of a long paragraph in a saved page.
function wrapLines(text: string, width = 400) {
  return text.split('\n').flatMap(line => {
    const parts: string[] = []; let rest = line;
    while (rest.length > width) {
      const space = rest.lastIndexOf(' ', width);
      const cut = space > width / 2 ? space : width;
      parts.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
    }
    parts.push(rest);
    return parts;
  }).join('\n');
}
function prefix(text: string, bytes: number) {
  const raw = Buffer.from(text);
  if (raw.length <= bytes) return text;
  return new TextDecoder('utf-8').decode(raw.subarray(0, bytes)).replace(/\uFFFD$/, '');
}

export function createWeb(config: WebConfig, runDir: string, termsFile?: string | null, options: Options = {}) {
  const ledger = path.join(runDir, 'ledger.jsonl'); const logs = path.join(runDir, 'logs');
  mkdirSync(logs, { recursive: true });
  const terms = termsFile ? readTerms(readFileSync(termsFile, 'utf8')) : [];
  const forbidden = (value: string) => scanText(value, terms).length > 0;
  const rows = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)) : [];
  let count = rows.filter(row => row.web_pending).length + rows.filter(row => row.web && !row.request_id).length;
  let lastSearch = 0; let queue = Promise.resolve();
  const start = () => {
    if (count >= (config.max_requests ?? 100)) return undefined;
    const request_id = randomUUID();
    appendLedger(ledger, { time: new Date().toISOString(), web_pending: request_id });
    count++; return request_id;
  };
  // The field is not called sha256 because that name marks a request sent to the model in the ledger.
  const record = (request_id: string, web: string, values: object, bytes?: Buffer) => appendLedger(ledger, {
    time: new Date().toISOString(), request_id, web, ...values, bytes: bytes?.length ?? 0,
    content_sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null });
  const save = (id: string, text: string) => writeFileSync(path.join(logs, `${id}.log`), wrapLines(text), 'utf8');
  return {
    async search(query: string, limit = 8) {
      if (forbidden(query)) return { error: 'forbidden_term' };
      const request_id = start(); if (!request_id) return { error: 'web_budget_exhausted' };
      const before = queue; let release!: () => void; queue = new Promise(resolve => { release = resolve; });
      await before;
      try {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, lastSearch + 2000 - Date.now())));
        lastSearch = Date.now();
        const url = new URL('/search', searchUrl(config));
        url.searchParams.set('q', query); url.searchParams.set('format', 'json');
        const response = await request(url, 45000);
        if ((response.statusCode ?? 0) >= 400) { response.destroy(); throw new Error('search HTTP error'); }
        const raw = await body(response, 20 * 1024 * 1024);
        const parsed = JSON.parse(raw.bytes.toString('utf8')); const id = randomUUID();
        const rows: any[] = Array.isArray(parsed.results) ? parsed.results : [];
        const kept = rows.filter(row => !forbidden(JSON.stringify(row)));
        // Lines keep the log readable. With terms only checked rows stay, or reading the log would stop the run.
        save(id, JSON.stringify(termsFile ? { results: kept } : parsed, null, 1));
        const removed = rows.length - kept.length; let truncated = raw.truncated;
        const results: { title: string; url: string; snippet: string }[] = [];
        for (const row of kept) {
          try { if (!['http:', 'https:'].includes(new URL(row.url).protocol)) continue; } catch { continue; }
          if (String(row.content ?? '').length > 300) truncated = true;
          const item = { title: String(row.title ?? ''), url: row.url as string,
            snippet: String(row.content ?? '').slice(0, 300) };
          if (results.length >= Math.max(0, Math.min(20, limit)) ||
              Buffer.byteLength(JSON.stringify({ id, results: [...results, item], unresponsive: 0,
                truncated: true, removed })) > 8192) {
            truncated = true; continue;
          }
          results.push(item);
        }
        const output = { id, results, unresponsive: Array.isArray(parsed.unresponsive_engines) ?
          parsed.unresponsive_engines.length : 0, truncated, ...(termsFile ? { removed } : {}) };
        while (Buffer.byteLength(JSON.stringify(output)) > 8192 && output.results.length) {
          output.results.pop(); output.truncated = true;
        }
        record(request_id, 'search', { id, query, status: response.statusCode }, raw.bytes);
        return output;
      } catch (error) {
        record(request_id, 'search', { query, status: null });
        return { error: 'search_unavailable', detail: error instanceof Error ? error.message : String(error) };
      } finally { release(); }
    },
    async fetch(value: string) {
      if (forbidden(value)) return { error: 'forbidden_term' };
      const request_id = start(); if (!request_id) return { error: 'web_budget_exhausted' };
      const redirects: string[] = []; const deadline = Date.now() + 30000; let final = value;
      try {
        for (;;) {
          if (forbidden(final)) { record(request_id, 'fetch', { url: value, status: null });
            return { error: 'forbidden_term' }; }
          const url = checkedUrl(final, options);
          const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('timeout');
          const response = await request(url, remaining, safeLookup(options)); const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (status >= 300 && status < 400 && location) {
            response.destroy(); if (redirects.length >= 5) throw new Error('too_many_redirects');
            final = new URL(location, url).href; redirects.push(final); continue;
          }
          const content_type = response.headers['content-type'] ?? '';
          const supported = /^(?:text\/[^;\s]+|application\/(?:json|xml|xhtml\+xml|[^;\s]+\+(?:json|xml)))$/i;
          if (status < 400 && !supported.test(content_type.split(';')[0].trim())) {
            response.destroy(); record(request_id, 'fetch', { url: value, final_url: final, status });
            return { error: 'unsupported_type', content_type };
          }
          const data = await body(response, 5 * 1024 * 1024); const decoded = decode(data.bytes, content_type);
          if (forbidden(decoded)) { record(request_id, 'fetch', { url: value, final_url: final, status: null });
            return { error: 'forbidden_term' }; }
          const text = /^(?:text\/html|application\/xhtml\+xml)/i.test(content_type) ? htmlText(decoded) : decoded;
          if (status < 200 || status >= 300) {
            record(request_id, 'fetch', { url: value, final_url: final, status }, data.bytes);
            return { status, text: prefix(text, 1024), final_url: final, content_type, redirects };
          }
          const id = randomUUID(); save(id, text);
          record(request_id, 'fetch', { id: `web:${id}`, url: value, final_url: final, status }, data.bytes);
          return { id: `web:${id}`, final_url: final, status, content_type, total_chars: text.length,
            text: prefix(text, 12 * 1024), truncated: data.truncated || Buffer.byteLength(text) > 12 * 1024,
            redirects };
        }
      } catch (error) {
        record(request_id, 'fetch', { url: value, final_url: final, status: null });
        return { error: error instanceof Error ? error.message : String(error), redirects };
      }
    },
  };
}
