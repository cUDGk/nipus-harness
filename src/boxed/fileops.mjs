import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = e => ({ error: e.code || 'ERROR', message: e.message });
const linesOf = text => text.split(/\r?\n/);

function read(file, ranges) {
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) return { path: file, error: 'too_large' };
    const bytes = fs.readFileSync(file);
    const lines = linesOf(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const selected = (ranges?.length ? ranges : [[1, lines.length]]).flatMap(([start, end]) =>
      lines.slice(Math.max(0, start - 1), end).map((line, i) => `${Math.max(1, start) + i}: ${line}`));
    return { path: file, sha256: hash(bytes), total_lines: lines.length, lines: selected, truncated: false };
  } catch (e) { return { path: file, ...error(e) }; }
}

function edit(item) {
  const file = item.path;
  try {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!bytes) {
      if (typeof item.content !== 'string') return { error: 'missing_file' };
      const data = Buffer.from(item.content.replace(/\r\n/g, '\n'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data, { flag: 'wx' });
      return { sha256: hash(data) };
    }
    const current = hash(bytes);
    if (current !== item.expected_hash) return { error: 'hash_mismatch', current_hash: current };
    if (item.content !== undefined) return { error: 'content_requires_new_file' };
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return { error: 'not_utf8' };
    const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    let text = bytes.subarray(bom ? 3 : 0).toString('utf8');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    for (const replacement of item.replacements ?? []) {
      const old = replacement.old.replace(/\r?\n/g, newline);
      const value = replacement.new.replace(/\r?\n/g, newline);
      const at = text.indexOf(old);
      if (!old || at < 0 || text.indexOf(old, at + 1) >= 0) return { error: 'replacement_not_unique' };
      text = text.slice(0, at) + value + text.slice(at + old.length);
    }
    const data = Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text)]);
    fs.writeFileSync(file, data);
    return { sha256: hash(data) };
  } catch (e) { return error(e); }
}

function search(item) {
  const found = [];
  const visit = file => {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (['.git', 'node_modules', 'bin', 'obj'].includes(path.basename(file))) return;
        for (const name of fs.readdirSync(file)) {
          if (!['.git', 'node_modules', 'bin', 'obj'].includes(name)) visit(path.join(file, name));
        }
      } else if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
        for (const [i, line] of linesOf(fs.readFileSync(file, 'utf8')).entries()) {
          if (line.includes(item.pattern)) found.push({ path: file, line: i + 1, text: line });
        }
      }
    } catch (e) { found.push({ path: file, ...error(e) }); }
  };
  for (const file of item.paths?.length ? item.paths : ['.']) visit(file);
  return found;
}

let result;
if (args.operation === 'edit') result = edit(args.item);
else {
  result = { reads: (args.item.reads ?? []).map(r => read(r.path, r.ranges)), lists: [], search: [] };
  if (args.item.log) result.reads.push(read(path.join(args.logDir, args.item.log.run_id + '.log'),
    args.item.log.ranges));
  for (const dir of args.item.list ?? []) {
    try { result.lists.push({ path: dir, entries: fs.readdirSync(dir) }); }
    catch (e) { result.lists.push({ path: dir, ...error(e) }); }
  }
  if (args.item.search) result.search = search(args.item.search);
  const max = args.maxBytes ?? 16384;
  const original = result;
  result = { reads: [], lists: [], search: [], truncated: false,
    continue: 'Use narrower ranges or paths in a new inspect call.' };
  let remaining = max - 1024;
  const take = (array, value) => {
    const size = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (size > remaining) { result.truncated = true; return false; }
    remaining -= size; array.push(value); return true;
  };
  for (const entry of original.reads) {
    const { lines, ...meta } = entry;
    if (!lines) { take(result.reads, entry); continue; }
    const output = { ...meta, lines: [] };
    if (!take(result.reads, output)) continue;
    for (const line of lines) {
      const short = line.length > 500 ? line.slice(0, 500) + ' [truncated]' : line;
      if (short !== line) { output.truncated = true; result.truncated = true; }
      if (!take(output.lines, short)) { output.truncated = true; break; }
    }
  }
  for (const item of original.lists) if (!take(result.lists, item)) break;
  for (const item of original.search) {
    if (item.text?.length > 500) { item.text = item.text.slice(0, 500) + ' [truncated]'; result.truncated = true; }
    if (!take(result.search, item)) break;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > max) result = { truncated: true, continue: result.continue };
  result.images = (args.item.images ?? []).map((file, index) => {
    if (index >= 4) return { path: file, error: 'too_many' };
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) return { path: file, error: 'too_large' };
      const data = fs.readFileSync(file);
      const hex = data.subarray(0, 12).toString('hex');
      const mimeType = hex.startsWith('89504e470d0a1a0a') ? 'image/png' : hex.startsWith('ffd8ff') ? 'image/jpeg'
        : /^474946383[79]61/.test(hex) ? 'image/gif' : /^52494646........57454250/.test(hex) ? 'image/webp' : '';
      return mimeType ? { path: file, mimeType, data: data.toString('base64') } : { path: file, error: 'invalid_type' };
    } catch (e) { return { path: file, ...error(e) }; }
  });
}
fs.writeFileSync(process.argv[3], JSON.stringify(result));
