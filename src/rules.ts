import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoxed } from './box.ts';

export type Scope = { allow?: string[]; protected?: string[]; max_added_lines?: number; allow_new_deps?: boolean;
  allow_docs?: boolean };
export type Violation = { id: string; path: string; line: number; kind: 'definite' | 'suspect' };
const script = fileURLToPath(new URL('./boxed/diff.mjs', import.meta.url));

export async function gitData(workspace: string, runDir: string, mode: string, head = '',
  box?: 'mxc' | 'none'): Promise<any> {
  const logPath = path.join(runDir, `git-${randomUUID()}.log`);
  const scratch = path.join(runDir, 'scratch');
  const output = path.join(scratch, `git-${randomUUID()}.json`);
  try {
    const run = await runBoxed({ workspace, scratch, box, readRoots: [path.dirname(script)], logPath, timeoutMs: 60000,
      command: [process.execPath, '--preserve-symlinks-main', script, mode, head, output] });
    if (run.status !== 'exited' || run.exitCode !== 0) {
      throw new Error(`Git inspection failed (${run.error ?? run.status}): ` +
        readFileSync(logPath, 'utf8').slice(0, 1000));
    }
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally { rmSync(output, { force: true }); }
}

export function matches(file: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const parts = pattern.replace(/\\/g, '/').split(/(\*\*\/|\*\*|\*)/);
    const expression = parts.map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*'
      : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`^${expression}$`).test(file);
  });
}

export function inspectDiff(data: { num: string; patch: string; untracked: { path: string;
  content: string | null }[]; added?: string[]; dependencies?: Record<string, boolean>; opaque?: string[];
  nested?: string[] }, scope: Scope = {}) {
  const files = new Map<string, { added: number; deleted: number; lines: Array<[number, string]>; fresh: boolean }>();
  const entries = data.num.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entries[i]);
    if (!match) continue;
    let name = match[3];
    if (!name) { i++; name = entries[++i]; }
    files.set(name.replace(/\\/g, '/'), { added: Number(match[1]) || 0, deleted: Number(match[2]) || 0,
      lines: [], fresh: (data.added ?? []).includes(name) });
  }
  // Inside a hunk every line starts with a mark, so "+++counter" there is the added line "++counter", not a header.
  let current = ''; let line = 0; let inHunk = false;
  for (const row of data.patch.split('\n')) {
    if (row.startsWith('diff --git ')) { inHunk = false; current = ''; }
    else if (row.startsWith('@@')) { inHunk = true; line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0); }
    // git ends the header with a tab when the name holds a space, as many Unity folders do.
    else if (!inHunk) { if (row.startsWith('+++ b/')) current = row.slice(6).replace(/\t$/, '').replace(/\\/g, '/'); }
    else if (row.startsWith('+')) files.get(current)?.lines.push([line++, row.slice(1)]);
    else if (row.startsWith(' ')) line++;
  }
  for (const item of data.untracked) {
    const lines = item.content === null || item.content === '' ? [] : item.content.replace(/\n$/, '').split('\n');
    files.set(item.path.replace(/\\/g, '/'), { added: lines.length, deleted: 0,
      lines: lines.map((text, i) => [i + 1, text]), fresh: true });
  }
  const violations: Violation[] = [];
  const add = (id: string, path: string, line: number,
    kind: Violation['kind'] = 'definite') => violations.push({ id, path, line, kind });
  let added = 0; let deleted = 0;
  for (const [file, info] of files) {
    added += info.added; deleted += info.deleted;
    const protectedFile = matches(file, scope.protected ?? []);
    if (scope.allow && !matches(file, scope.allow)) add('out_of_scope', file, info.lines[0]?.[0] ?? 1);
    if (protectedFile) add('protected', file, info.lines[0]?.[0] ?? 1);
    if (!scope.allow_docs && info.fresh && /(^|\/)(?:readme(?:\.[^/]*)?|[^/]+\.md)$/i.test(file)) {
      add('new_doc', file, 1);
    }
    if (!scope.allow_new_deps && data.dependencies?.[file]) {
      add('new_dep', file, info.lines.find(([, text]) => /"(?:dependencies|devDependencies)"\s*:/.test(text))?.[0]
        ?? info.lines[0]?.[0] ?? 1);
    }
    // A lockfile adds many lines, so report it once rather than per line.
    if (!scope.allow_new_deps && /(^|\/)(?:package-lock\.json|requirements[^/]*\.txt)$/.test(file) &&
        info.lines.length) {
      add('new_dep', file, info.lines[0][0]);
    }
    for (const [n, text] of info.lines) {
      if (/@ts-ignore|@ts-nocheck|eslint-disable|#pragma\s+warning\s+disable|--no-verify/.test(text)) {
        add('suppression', file, n);
      }
      if (!protectedFile && !/(^|\/)(?:test|tests|fixtures|testdata)(?:\/|$)/i.test(file) &&
          /\b(?:TODO|FIXME)\b/.test(text)) add('leftover', file, n);
      if (!scope.allow_new_deps && /\.csproj$/i.test(file) && /<PackageReference\b/i.test(text)) {
        add('new_dep', file, n);
      }
    }
    for (let i = 0; i < info.lines.length; i++) {
      const [n, text] = info.lines[i];
      if (!/\bcatch\b/.test(text)) continue;
      let block = text;
      for (let j = i + 1; j < info.lines.length && info.lines[j][0] === info.lines[j - 1][0] + 1 && j < i + 5;
        j++) block += '\n' + info.lines[j][1];
      if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(block)) add('swallow', file, n, 'suspect');
    }
  }
  // A source file too large to read as text cannot be checked, so a person has to look at it.
  for (const file of data.opaque ?? []) add('too_large', file, 1, 'suspect');
  // Its files would pass every check unseen, so it has to go before the work can finish.
  for (const folder of data.nested ?? []) add('nested_repository', folder, 1);
  if (scope.max_added_lines !== undefined && added > scope.max_added_lines) add('too_large',
    [...files.keys()][0] ?? '', 1, 'suspect');
  return { diff: { files: [...files.keys()], added, deleted }, violations };
}
