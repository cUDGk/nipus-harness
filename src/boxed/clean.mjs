import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readTerms, scanBytes, scanText } from '../scan.ts';
import { onPath } from './which.mjs';

const [input, output] = process.argv.slice(2);
const config = JSON.parse(readFileSync(input, 'utf8'));
const terms = readTerms(config.terms);
const gitFile = onPath('git');
const git = (...args) => execFileSync(gitFile, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', ...args],
  { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_NO_REPLACE_OBJECTS: '1' },
    maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
const result = { head: '', files: 0, objects: 0, large: [], hits: [] };
const scan = (name, bytes) => {
  if (scanText(name, terms).length || (bytes && scanBytes(bytes, terms).length)) result.hits.push(name);
};
const walk = (root, name = '', workspace = false) => {
  const full = path.join(root, name);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error('Symbolic link in scan');
  if (stat.isDirectory()) {
    for (const item of readdirSync(full)) {
      if (workspace && !name && item.toLowerCase() === '.git') continue;
      walk(root, path.join(name, item), workspace);
    }
  } else if (stat.isFile()) {
    result.files++;
    if (stat.size > 64 * 1024 * 1024 && config.mode !== 'diff') { result.large.push(full); scan(full); }
    else scan(full, readFileSync(full));
  } else throw new Error('Unsupported file in scan');
};
try {
  result.head = git('rev-parse', '--verify', 'HEAD').toString().trim();
  if (config.mode === 'diff') {
    const changed = git('diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', config.commit, '--')
      .toString('utf8').split('\0');
    const untracked = git('ls-files', '--others', '-z').toString('utf8').split('\0');
    for (const name of new Set([...changed, ...untracked].filter(Boolean))) {
      scan(name);
      try { walk(process.cwd(), name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    writeFileSync(output, JSON.stringify(result));
    process.exit(0);
  }
  git('merge-base', '--is-ancestor', config.commit, 'HEAD');
  walk(process.cwd(), '', true);
  // config, reflogs and FETCH_HEAD can name the place a repository came from. Objects are read below, unpacked.
  for (const item of readdirSync('.git')) if (item !== 'objects') walk(path.resolve('.git'), item);
  for (const root of config.roots) walk(root);
  const child = spawn(gitFile, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL',
    'cat-file', '--batch-all-objects', '--batch'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_NO_REPLACE_OBJECTS: '1' } });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Object inspection failed')));
  });
  let header = Buffer.alloc(0), name = '', remaining = -1, parts = [];
  for await (const chunk of child.stdout) {
    let at = 0;
    while (at < chunk.length) {
      if (remaining < 0) {
        const end = chunk.indexOf(10, at);
        header = Buffer.concat([header, chunk.subarray(at, end < 0 ? chunk.length : end)]);
        if (header.length > 200) throw new Error('Invalid object header');
        if (end < 0) break;
        const match = /^([a-f0-9]+) (\w+) (\d+)$/.exec(header.toString());
        if (!match || !Number.isSafeInteger(Number(match[3]))) throw new Error('Invalid object batch');
        name = match[1]; remaining = Number(match[3]); parts = []; header = Buffer.alloc(0); at = end + 1;
      } else if (remaining) {
        const size = Math.min(remaining, chunk.length - at);
        parts.push(chunk.subarray(at, at + size)); remaining -= size; at += size;
      } else {
        if (chunk[at++] !== 10) throw new Error('Invalid object size');
        scan(name, Buffer.concat(parts)); result.objects++; remaining = -1;
      }
    }
  }
  await done;
  if (remaining !== -1 || header.length) throw new Error('Incomplete object batch');
  writeFileSync(output, JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
