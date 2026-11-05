import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexExecutable } from '../src/box.ts';

const limits = path.resolve('src/limits.ts');

// Node stands in for codex.exe and runs this file when it is given "app-server" with this folder as the current one.
const fakeServer = (second: string) => `
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (message.id === 2) console.log(JSON.stringify({ id: 2, ${second} }));
});`;

test('limits prints the rate limits from the app server', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'limits-'));
  try {
    writeFileSync(path.join(dir, 'app-server'), fakeServer('result: { rateLimits: { primary: { usedPercent: 12 } } }'));
    const out = execFileSync(process.execPath, [limits], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, HARNESS_CODEX_EXE: process.execPath } });
    assert.equal(JSON.parse(out).rateLimits.primary.usedPercent, 12);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('limits fails when the app server fails, so the gate does not read a value that is not there', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'limits-'));
  try {
    writeFileSync(path.join(dir, 'app-server'), fakeServer("error: { message: 'not signed in' }"));
    const failed = spawnSync(process.execPath, [limits], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, HARNESS_CODEX_EXE: process.execPath } });
    assert.equal(failed.status, 1); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /not signed in/);
    writeFileSync(path.join(dir, 'app-server'), 'process.exit(3)');
    const ended = spawnSync(process.execPath, [limits], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, HARNESS_CODEX_EXE: process.execPath } });
    assert.equal(ended.status, 1); assert.match(ended.stderr, /ended before answering/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the Codex program is found from the setting, then on PATH, then beside the npm shim', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-path-'));
  try {
    const empty = path.join(dir, 'empty'); mkdirSync(empty);
    assert.throws(() => codexExecutable({ PATH: empty }), /Codex CLI not found/);
    const npm = path.join(dir, 'npm'); mkdirSync(npm); writeFileSync(path.join(npm, 'codex.cmd'), '');
    assert.throws(() => codexExecutable({ PATH: npm }), /Codex CLI not found/);
    const program = path.join(npm, String.raw`node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`);
    mkdirSync(path.dirname(program), { recursive: true }); writeFileSync(program, '');
    assert.equal(codexExecutable({ PATH: npm }), program);
    const plain = path.join(dir, 'plain'); mkdirSync(plain); writeFileSync(path.join(plain, 'codex.exe'), '');
    assert.equal(codexExecutable({ PATH: `${plain};${npm}` }), path.join(plain, 'codex.exe'));
    assert.equal(codexExecutable({ PATH: empty, HARNESS_CODEX_EXE: 'C:\\set\\codex.exe' }), 'C:\\set\\codex.exe');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('harness.json of the machine hides more variables and names the search server', () => {
  const agent = mkdtempSync(path.join(os.tmpdir(), 'machine-'));
  const load = (env: NodeJS.ProcessEnv = {}) => {
    const code = `Promise.all([import(${JSON.stringify(pathToFileURL(path.resolve('src/box.ts')).href)}), import(${JSON.stringify(pathToFileURL(path.resolve('src/web.ts')).href)})]).then(([box, web]) => { ` +
      `let url = ''; try { url = web.searchUrl({}).href; } catch (error) { url = error.message; } ` +
      `console.log(JSON.stringify([box.secretEnvironment.test('PARENT_AGENT_X'), box.secretEnvironment.test('PLAIN'), box.secretEnvironment.test('MY_TOKEN'), url])); })`;
    const base: NodeJS.ProcessEnv = { ...process.env, HARNESS_AGENT_DIR: agent, ...env }; if (!env.HARNESS_SEARCH_URL) delete base.HARNESS_SEARCH_URL;
    return JSON.parse(execFileSync(process.execPath, ['-e', code], { env: base, encoding: 'utf8' }));
  };
  try {
    assert.deepEqual(load(), [false, false, true, 'No search server: set search_url in web, or HARNESS_SEARCH_URL']);
    assert.deepEqual(load({ HARNESS_SEARCH_URL: 'http://from-env:1' }).at(-1), 'http://from-env:1/');
    writeFileSync(path.join(agent, 'harness.json'), JSON.stringify({ hide_env: '^PARENT_AGENT', search_url: 'http://from-file:2' }));
    assert.deepEqual(load(), [true, false, true, 'http://from-file:2/']);
    assert.deepEqual(load({ HARNESS_SEARCH_URL: 'http://from-env:1' }).at(-1), 'http://from-env:1/');
    writeFileSync(path.join(agent, 'harness.json'), '{ broken');
    assert.throws(() => load());
  } finally { rmSync(agent, { recursive: true, force: true }); }
});
