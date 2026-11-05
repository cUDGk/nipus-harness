import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { checkScratch, runBoxed, validateRoot } from './box.ts';
import { atomicJson } from './commands.ts';
import { matches } from './rules.ts';
import { readTerms, scanBytes, scanText, scanValue } from './scan.ts';
import { onPath } from './boxed/which.mjs';

export const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
const noHooks = path.join(os.tmpdir(), `clean-no-hooks-${randomUUID()}`);
const actualPath = (value: string): string => existsSync(value) ? realpathSync(value)
  : path.join(actualPath(path.dirname(value)), path.basename(value));
const git = (cwd: string, args: string[], input?: Uint8Array) => execFileSync(onPath('git'),
  ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks}`, '-c', 'core.autocrlf=false', ...args],
  { cwd, env, input, maxBuffer: 1024 * 1024 * 1024, windowsHide: true });

// Reasons written here name no file content, so they may be shown. Anything else is reported as a plain failure.
export class CleanFailure extends Error {}

function readBlobs(source: string, oids: string[]) {
  const batch = git(source, ['cat-file', '--batch'], Buffer.from(oids.join('\n') + '\n'));
  let at = 0;
  return oids.map(oid => {
    const end = batch.indexOf(10, at);
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(batch.subarray(at, end).toString('ascii'));
    if (!match || match[1] !== oid) throw new CleanFailure('Invalid blob');
    const size = Number(match[2]);
    const bytes = batch.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size || batch[end + 1 + size] !== 10) throw new CleanFailure('Invalid blob length');
    at = end + 2 + size;
    return bytes;
  });
}

// Makes a new one-commit repository from one tree of the source, after checking every name and byte against the
// terms. History never comes along, so an old commit holding a forbidden file cannot reach the worker.
export function cleanCopy(file: string) {
  const declaration = readFileSync(file);
  const d = JSON.parse(declaration.toString('utf8'));
  const keys = ['id', 'source', 'commit', 'include', 'exclude', 'dest', 'terms_file'];
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !keys.includes(k)) ||
      typeof d.id !== 'string' || !/^[\w-]+$/.test(d.id) ||
      !['source', 'dest', 'terms_file'].every(k => typeof d[k] === 'string' && path.isAbsolute(d[k])) ||
      typeof d.commit !== 'string' || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(d.commit) ||
      !Array.isArray(d.include) || !d.include.length || !d.include.every((x: unknown) => typeof x === 'string') ||
      (d.exclude !== undefined && (!Array.isArray(d.exclude) ||
        !d.exclude.every((x: unknown) => typeof x === 'string')))) throw new CleanFailure('Invalid declaration');
  try { validateRoot(d.dest); } catch { throw new CleanFailure('Forbidden destination'); }
  const source = realpathSync(d.source);
  const commit = git(source, ['rev-parse', '--verify', `${d.commit}^{commit}`]).toString().trim();
  if (commit !== d.commit) throw new CleanFailure('Invalid commit');
  const existing = existsSync(d.dest);
  if (existing && readdirSync(d.dest).length) throw new CleanFailure('Destination is not empty');
  const resolved = actualPath(d.dest);
  const relative = path.relative(source, resolved);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new CleanFailure('Destination inside source');
  }
  const termsData = readFileSync(d.terms_file);
  let terms: ReturnType<typeof readTerms>;
  try { terms = readTerms(termsData.toString('utf8')); }
  catch (error) { throw new CleanFailure((error as Error).message); }
  const included = git(source, ['ls-tree', '-r', '-z', '--full-tree', d.commit]).toString('utf8').split('\0')
    .filter(Boolean).map(line => {
      const m = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!m) throw new CleanFailure('Invalid tree entry');
      return { mode: m[1], type: m[2], oid: m[3], path: m[4] };
    }).filter(item => matches(item.path, d.include));
  if (included.some(item => item.type !== 'blob' || !['100644', '100755'].includes(item.mode))) {
    throw new CleanFailure('Unsupported tree entry');
  }
  const tree = included.filter(item => !matches(item.path, d.exclude ?? []));
  if (!tree.length) throw new CleanFailure('Nothing included');
  // Windows drops trailing dots and spaces and keeps 8.3 names, so ".git." and "git~1" would land inside .git.
  if (tree.some(item => item.path.split('/').some(part => !part || part === '.' || part === '..' ||
      part.toLowerCase() === '.git' || /^git~/i.test(part) || /[. ]$/.test(part) ||
      /[\\:*?"<>|\r\n]/.test(part)))) throw new CleanFailure('Invalid tree path');
  const blobs = readBlobs(source, tree.map(item => item.oid));
  const hits = tree.flatMap((item, i) => {
    const inName = scanText(item.path, terms);
    // A name that holds a term must not be printed either, so only its hash goes in the report.
    const place = inName.length ? { path_sha256: hash(Buffer.from(item.path)) } : { path: item.path };
    return [...new Set([...inName, ...scanBytes(blobs[i], terms)])].map(term => ({ ...place, term }));
  });
  if (hits.length) return { id: d.id, status: 'quarantined', matches: hits };
  let created = false;
  try {
    if (!existing) { mkdirSync(d.dest, { recursive: true }); created = true; }
    git(d.dest, ['init', '-q', `--object-format=${d.commit.length === 64 ? 'sha256' : 'sha1'}`]);
    for (const [i, item] of tree.entries()) {
      const target = path.join(d.dest, ...item.path.split('/'));
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, blobs[i], { flag: 'wx' });
    }
    // One process for all files: a process per file is thousands of process starts on a real repository.
    const oids = git(d.dest, ['hash-object', '-w', '--no-filters', '--stdin-paths'],
      Buffer.from(tree.map(item => item.path).join('\n') + '\n')).toString().trim().split(/\r?\n/);
    if (oids.length !== tree.length || tree.some((item, i) => item.oid !== oids[i])) {
      throw new CleanFailure('Blob mismatch');
    }
    git(d.dest, ['update-index', '-z', '--index-info'],
      Buffer.from(tree.map(item => `${item.mode} ${item.oid}\t${item.path}\0`).join('')));
    git(d.dest, ['-c', 'user.name=clean-room', '-c', 'user.email=clean-room@localhost',
      'commit', '-q', '-m', 'clean copy']);
    const commit = git(d.dest, ['rev-parse', 'HEAD']).toString().trim();
    const actual = git(d.dest, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8');
    const expected = tree.map(x => `${x.mode} ${x.type} ${x.oid}\t${x.path}\0`).join('');
    if (actual !== expected) throw new CleanFailure('Tree mismatch');
    const files = tree.map((item, i) => ({ path: item.path, sha256: hash(blobs[i]), bytes: blobs[i].length }));
    const manifestDir = path.resolve(import.meta.dirname, '../runs/.clean', `${d.id}-${Date.now()}-${randomUUID()}`);
    mkdirSync(manifestDir, { recursive: true });
    const manifest = path.join(manifestDir, 'manifest.json');
    atomicJson(manifest, { declaration_sha256: hash(declaration), source: d.source, commit: d.commit,
      dest: d.dest, clean_commit: commit, terms_file_sha256: hash(termsData), files });
    return { id: d.id, dest: d.dest, commit, manifest, manifest_sha256: hash(readFileSync(manifest)),
      files: files.length, bytes: files.reduce((n, item) => n + item.bytes, 0) };
  } catch (error) {
    if (created) rmSync(d.dest, { recursive: true, force: true });
    throw error;
  }
}

export class CleanBlocked extends Error {}

// Runs the scanner in the box. The terms pass through a file that is gone before any worker command can run.
async function boxedScan(workspace: string, runDir: string, readRoots: string[], config: object) {
  const scratch = path.join(runDir, 'scratch');
  checkScratch(scratch);
  mkdirSync(scratch, { recursive: true });
  const input = path.join(scratch, `clean-${randomUUID()}.json`);
  const output = input + '.out';
  const logPath = input + '.log';
  try {
    writeFileSync(input, JSON.stringify(config));
    const run = await runBoxed({ workspace, scratch, logPath, box: 'mxc',
      readRoots: [...readRoots, import.meta.dirname], timeoutMs: 600000,
      command: [process.execPath, '--preserve-symlinks-main', path.join(import.meta.dirname, 'boxed/clean.mjs'),
        input, output] });
    if (run.status !== 'exited' || run.exitCode !== 0) throw new Error('boxed inspection failed');
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally { for (const file of [input, output, logPath]) rmSync(file, { force: true }); }
}

export async function scanDiff(workspace: string, runDir: string, head: string, termsFile: string) {
  const scanned = await boxedScan(workspace, runDir, [], { mode: 'diff', commit: head,
    terms: readFileSync(termsFile, 'utf8') });
  return scanned.hits as string[];
}

export async function verifyClean(task: { workspace: string; read_roots: string[]; box?: string;
  forbidden_terms_file: string | null; clean_room?: { manifest: string };
  host_jobs?: Record<string, { output: string }> }, runDir: string) {
  try {
    if (task.box === 'none') throw new Error('box must be mxc');
    if (Object.values(task.host_jobs ?? {}).some(job => job.output !== 'summary')) {
      throw new Error('host job output must be summary');
    }
    if (!task.forbidden_terms_file) throw new Error('terms file missing');
    if (!task.read_roots.every(root => path.isAbsolute(root) && existsSync(root))) {
      throw new Error('read root missing');
    }
    const manifestData = readFileSync(task.clean_room!.manifest);
    const manifest = JSON.parse(manifestData.toString('utf8'));
    if (realpathSync(task.workspace).toLowerCase() !== realpathSync(manifest.dest).toLowerCase()) {
      throw new Error('manifest destination mismatch');
    }
    const dotgit = path.join(task.workspace, '.git');
    if (!lstatSync(dotgit).isDirectory()) throw new Error('.git is not a directory');
    const present = (file: string) => { try { lstatSync(file); return true; } catch (error: any) {
      if (error.code === 'ENOENT') return false; throw error;
    } };
    if (present(path.join(dotgit, 'objects/info/alternates'))) throw new Error('git alternates present');
    if (present(path.join(dotgit, 'shallow'))) throw new Error('shallow repository');
    if (typeof manifest.clean_commit !== 'string' || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.clean_commit)) {
      throw new Error('invalid manifest commit');
    }
    const terms = readFileSync(task.forbidden_terms_file);
    const scanned = await boxedScan(task.workspace, runDir, task.read_roots, { terms: terms.toString('utf8'),
      roots: task.read_roots, commit: manifest.clean_commit });
    if (scanned.hits.length) throw new Error('forbidden term in inspected data');
    return { manifest_sha256: hash(manifestData), terms_file_sha256: hash(terms), head: scanned.head,
      read_roots: task.read_roots, files: scanned.files, objects: scanned.objects, large: scanned.large };
  } catch (error) {
    const messages = ['box must be mxc', 'host job output must be summary', 'terms file missing',
      'read root missing', 'manifest destination mismatch', '.git is not a directory', 'git alternates present',
      'shallow repository', 'invalid manifest commit', 'boxed inspection failed',
      'forbidden term in inspected data'];
    throw new CleanBlocked(error instanceof Error && messages.includes(error.message)
      ? error.message : 'clean inspection failed');
  }
}

export function audit(dir: string) {
  const task = JSON.parse(readFileSync(path.join(dir, 'task.json'), 'utf8'));
  if (!task.clean_room || !task.forbidden_terms_file) throw new Error('Not a clean-room run');
  const rows = readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
  const terms = readTerms(readFileSync(task.forbidden_terms_file, 'utf8'));
  const requests = rows.filter(row => row.sha256);
  const requestDir = path.join(dir, 'requests');
  const names = existsSync(requestDir) ? readdirSync(requestDir) : [];
  const missing: string[] = []; const extra: string[] = []; const mismatch: string[] = [];
  const forbidden: string[] = []; const expected = new Set<string>();
  const strings = (v: any): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings)
    : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];
  for (const row of requests) {
    const name = `${row.request_number}.json.gz`;
    if (!Number.isInteger(row.request_number) || row.request_number < 1 || expected.has(name)) {
      mismatch.push(name); continue;
    }
    expected.add(name);
    if (!names.includes(name)) { missing.push(name); continue; }
    try {
      const compressed = readFileSync(path.join(requestDir, name));
      const bytes = gunzipSync(compressed);
      if (hash(bytes) !== row.sha256 || bytes.length !== row.bytes || hash(compressed) !== row.gzip_sha256) {
        mismatch.push(name);
      }
      if (scanBytes(bytes, terms).length) forbidden.push(name);
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!forbidden.includes(name) && strings(parsed).some(value => scanValue(value, terms).length)) {
        forbidden.push(name);
      }
    } catch { mismatch.push(name); }
  }
  // A removed pair of a row and its copy leaves a gap in the numbers.
  const numbers = requests.map(row => row.request_number).filter(Number.isInteger).sort((a, b) => a - b);
  numbers.forEach((number, index) => { if (number !== index + 1) mismatch.push(`gap before ${number}`); });
  // Every reply follows a request, so more replies than requests means a row is gone. Whoever can edit the run folder
  // can still remove both; the ledger protects against the worker, which cannot write there, not against the PC's user.
  if (rows.filter(row => 'usage' in row).length > requests.length) mismatch.push('more replies than requests');
  for (const name of names) if (!expected.has(name)) {
    extra.push(name);
    try {
      const bytes = gunzipSync(readFileSync(path.join(requestDir, name)));
      if (scanBytes(bytes, terms).length) forbidden.push(name);
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!forbidden.includes(name) && strings(parsed).some(value => scanValue(value, terms).length)) {
        forbidden.push(name);
      }
    } catch { /* Extra receipts already make the audit fail. */ }
  }
  const verified = rows.find(row => row.clean_room)?.clean_room;
  if (!verified) mismatch.push('clean_room');
  const result = { ok: !missing.length && !extra.length && !mismatch.length && !forbidden.length,
    missing, extra, mismatch, forbidden, models: [...new Set(requests.map(r => r.model))],
    efforts: [...new Set(requests.map(r => r.effort))],
    tools: [...new Set(requests.flatMap(r => r.tools ?? []))], manifest_sha256: verified?.manifest_sha256 ?? null,
    read_roots: task.read_roots ?? [], box: task.box ?? 'mxc' };
  atomicJson(path.join(dir, 'audit.json'), result);
  return result;
}

export function exportPatch(dir: string, output: string) {
  const task = JSON.parse(readFileSync(path.join(dir, 'task.json'), 'utf8'));
  if (task.box === 'none') throw new Error('box must be mxc');
  const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const head = state.start.head;
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('Invalid start HEAD');
  const index = path.join(dir, `export-${randomUUID()}.index`);
  const run = (args: string[], input?: Uint8Array) => execFileSync(onPath('git'),
    ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks}`, '-c', 'core.autocrlf=false', ...args],
    { cwd: task.workspace, env: { ...env, GIT_INDEX_FILE: index }, input, windowsHide: true,
      maxBuffer: 1024 * 1024 * 1024 });
  try {
    run(['read-tree', head]);
    // Same result as a commit would have: .gitignore keeps build output out. The worker cannot write .git, so the
    // config that could name a filter command is still the one this harness made or checked.
    run(['add', '-A', '--', '.']);
    const patch = run(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', head]);
    const num = run(['diff', '--cached', '--numstat', '-z', '--no-renames', head]).toString().split('\0')
      .filter(Boolean).map(line => /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(line)).filter(x => x !== null);
    writeFileSync(output, patch);
    return { patch: path.resolve(output), sha256: hash(patch), files: num.map(x => x[3]),
      added: num.reduce((n, x) => n + (Number(x[1]) || 0), 0),
      deleted: num.reduce((n, x) => n + (Number(x[2]) || 0), 0) };
  } finally { rmSync(index, { force: true }); rmSync(index + '.lock', { force: true }); }
}
