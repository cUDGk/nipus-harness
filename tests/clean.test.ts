import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTerms, scanBytes, scanText } from '../src/scan.ts';
import { cleanCopy, audit, exportPatch, hash, scanDiff, verifyClean } from '../src/clean.ts';
import { installGate, roleContext } from '../src/gate.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=NUL',
  '-c', 'core.fsmonitor=false', '-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args],
  { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });

test('scanning normalizes text and detects binary encodings with line numbers', () => {
  const terms = readTerms('\nforbidden-word-alpha\nother-term\n');
  assert.deepEqual(scanText('FORBIDDEN-WORD-ALPHA', terms), [2]);
  assert.deepEqual(scanBytes(Buffer.from('ＦＯＲＢＩＤＤＥＮ－ＷＯＲＤ－ＡＬＰＨＡ'), terms), [2]);
  assert.deepEqual(scanBytes(Buffer.from('forbidden-word-alpha', 'utf16le'), terms), [2]);
  assert.deepEqual(scanBytes(Buffer.from([255, ...Buffer.from('other-term')]), terms), [3]);
  assert.deepEqual(scanBytes(Buffer.from('ordinary text'), terms), []);
});

test('copy reads only the selected tree and quarantines current content', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
  let manifestDir = '';
  try {
    const source = path.join(root, 'source'); mkdirSync(source); git(source, 'init', '-q');
    writeFileSync(path.join(source, 'old.txt'), 'forbidden-word-alpha');
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'old');
    rmSync(path.join(source, 'old.txt'));
    writeFileSync(path.join(source, '.gitattributes'), 'included.txt export-ignore export-subst\n');
    writeFileSync(path.join(source, 'included.txt'), '$Format:%H$\n');
    writeFileSync(path.join(source, 'excluded.txt'), 'excluded');
    // CRLF stored in a blob must stay as it is and must not look modified in the box.
    writeFileSync(path.join(source, 'crlf.txt'), 'one\r\ntwo\r\n');
    git(source, 'add', '-A'); git(source, 'commit', '-qm', 'new');
    const commit = git(source, 'rev-parse', 'HEAD').trim();
    const terms = path.join(root, 'terms'); writeFileSync(terms, 'forbidden-word-alpha\n');
    const dest = path.join(root, 'new-parent', 'copy'); const declaration = path.join(root, 'declaration.json');
    const d = { id: 'test', source, dest, commit, terms_file: terms, include: ['**'], exclude: ['excluded.txt'] };
    writeFileSync(declaration, JSON.stringify({ ...d, dest: path.join(source, 'missing', 'nested') }));
    assert.throws(() => cleanCopy(declaration), /Destination inside source/);
    writeFileSync(declaration, JSON.stringify(d));
    const result = cleanCopy(declaration);
    assert.ok('manifest' in result && typeof result.manifest === 'string');
    manifestDir = path.dirname(result.manifest);
    assert.equal(readFileSync(path.join(dest, 'included.txt'), 'utf8'), '$Format:%H$\n');
    assert.deepEqual(readdirSync(dest).sort(), ['.git', '.gitattributes', 'crlf.txt', 'included.txt'].sort());
    assert.equal(readFileSync(path.join(dest, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\n');
    assert.match(git(source, 'log', '--all', '-p'), /forbidden-word-alpha/);
    assert.doesNotMatch(git(dest, 'log', '--all', '-p'), /forbidden-word-alpha/);
    assert.match(git(source, 'cat-file', '--batch-all-objects', '--batch'), /forbidden-word-alpha/);
    assert.doesNotMatch(git(dest, 'cat-file', '--batch-all-objects', '--batch'), /forbidden-word-alpha/);
    const run = path.join(root, 'run'); mkdirSync(run);
    const task = { workspace: dest, read_roots: [], forbidden_terms_file: terms,
      clean_room: { manifest: result.manifest }, box: 'mxc' };
    const verified = await verifyClean(task, run);
    assert.equal(verified.head, result.commit); assert.ok(verified.objects > 0);
    writeFileSync(terms, 'forbidden-word-alpha\nanother-made-up-word\n');
    assert.notEqual((await verifyClean(task, run)).terms_file_sha256, verified.terms_file_sha256);
    writeFileSync(terms, 'forbidden-word-alpha\n');
    const agent = path.join(root, 'agent'); mkdirSync(agent);
    const requestCount = path.join(root, 'request-count');
    const preload = `import fs from 'node:fs'; let calls = 0; globalThis.fetch = async () => {` +
      `fs.appendFileSync(process.env.CLEAN_TEST_COUNT, 'x');` +
      `if (++calls === 1) return new Response('temporary', {status:503});` +
      `if (calls === 4 && process.env.CLEAN_TEST_MODE === 'finish') ` +
      `fs.writeFileSync(process.env.CLEAN_TEST_WORK + '/finish.txt', 'forbidden-word-alpha');` +
      `const child = calls === 2; const item = {type:'function_call', id:'item_'+calls, call_id:'call_'+calls,` +
      `name:child?'delegate':'finish',arguments:JSON.stringify(child?{role:'worker',task:'ordinary task'}:` +
      `{state:'done',summary:'done'}),status:'completed'};` +
      `const selected = process.env.CLEAN_TEST_MODE === 'resume' ? {type:'message',id:'message_1',role:'assistant',` +
      `content:[{type:'output_text',text:'ordinary reply',annotations:[]}],status:'completed'} : item;` +
      `const response = {id:'response_1',status:'completed',output:[selected],usage:{input_tokens:30,` +
      `input_tokens_details:{cached_tokens:10},output_tokens:5,output_tokens_details:{reasoning_tokens:2}}};` +
      `return new Response([{type:'response.output_item.added',output_index:0,item:selected},` +
      `{type:'response.output_item.done',output_index:0,item:selected},{type:'response.completed',response}]` +
      `.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join('')+'data: [DONE]\\n\\n',` +
      `{headers:{'content-type':'text/event-stream'}}) };`;
    const preloadFile = path.join(root, 'mock.mjs'); writeFileSync(preloadFile, preload);
    const taskFile = path.join(root, 'task.json');
    writeFileSync(taskFile, JSON.stringify({ ...task, id: 'clean-test', goal: 'ordinary task',
      model: 'gpt-6.1-terra', effort: 'medium', max_quota_percent: 10, base_url: 'http://localhost:1234/v1',
      roles: { worker: { model: 'gpt-6.1-terra', effort: 'low', tools: ['finish'], max_quota_percent: 10 } } }));
    const runCli = (args = ['run', taskFile], extra: Record<string, string> = {}) => JSON.parse(execFileSync(
      process.execPath, ['--import', pathToFileURL(preloadFile).href, path.resolve('src/cli.ts'), ...args],
      { encoding: 'utf8',
        env: { ...process.env, HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake-test-key',
          HARNESS_QUOTA_COMMAND: '', HARNESS_RETRY_BASE_MS: '10', CLEAN_TEST_COUNT: requestCount, ...extra } }));
    const completed = runCli();
    try {
      assert.equal(completed.status, 'completed', JSON.stringify(completed));
      assert.equal(readFileSync(requestCount, 'utf8'), 'xxxx');
      assert.equal(audit(completed.run_dir).ok, true);
      assert.equal(readdirSync(path.join(completed.run_dir, 'requests')).length, 4);
    } finally { if (completed.run_dir) rmSync(completed.run_dir, { recursive: true, force: true }); }
    const originalTask = JSON.parse(readFileSync(taskFile, 'utf8'));
    const resumeCount = path.join(root, 'resume-count');
    writeFileSync(taskFile, JSON.stringify({ ...originalTask, max_continues: 0 }));
    const interrupted = runCli(undefined, { CLEAN_TEST_MODE: 'resume', CLEAN_TEST_COUNT: resumeCount });
    try {
      assert.equal(interrupted.status, 'needs_judgment');
      assert.equal(readFileSync(resumeCount, 'utf8'), 'xx');
      writeFileSync(path.join(dest, 'resume.txt'), 'forbidden-word-alpha');
      const resumed = runCli(['resume', interrupted.run_dir],
        { CLEAN_TEST_MODE: 'resume', CLEAN_TEST_COUNT: resumeCount });
      assert.equal(resumed.status, 'quarantined');
      assert.equal(readFileSync(resumeCount, 'utf8'), 'xx');
      rmSync(path.join(dest, 'resume.txt'));
    } finally {
      if (interrupted.run_dir) rmSync(interrupted.run_dir, { recursive: true, force: true });
      writeFileSync(taskFile, JSON.stringify(originalTask));
    }
    const finishCount = path.join(root, 'finish-count');
    writeFileSync(taskFile, JSON.stringify({ ...originalTask, max_continues: 0 }));
    const finish = runCli(undefined, { CLEAN_TEST_MODE: 'finish', CLEAN_TEST_WORK: dest,
      CLEAN_TEST_COUNT: finishCount });
    try {
      assert.equal(finish.status, 'needs_judgment');
      assert.ok(finish.violations.some((item: { id: string; kind: string }) =>
        item.id === 'forbidden_term' && item.kind === 'definite'));
      assert.equal(readFileSync(finishCount, 'utf8'), 'xxxx');
    } finally {
      rmSync(path.join(dest, 'finish.txt'), { force: true });
      if (finish.run_dir) rmSync(finish.run_dir, { recursive: true, force: true });
      writeFileSync(taskFile, JSON.stringify(originalTask));
    }
    const assertBlocked = (changes: object = {}) => {
      writeFileSync(taskFile, JSON.stringify({ ...originalTask, ...changes }));
      const value = runCli();
      try {
        assert.equal(value.status, 'quarantined', JSON.stringify(value));
        assert.equal(readFileSync(requestCount, 'utf8'), 'xxxx');
      } finally {
        if (value.run_dir) rmSync(value.run_dir, { recursive: true, force: true });
        writeFileSync(taskFile, JSON.stringify(originalTask));
      }
    };
    assertBlocked({ box: 'none' });
    writeFileSync(path.join(dest, 'local.txt'), 'forbidden-word-alpha');
    await assert.rejects(verifyClean(task, run), /forbidden term/);
    assert.ok((await scanDiff(dest, run, result.commit!, terms)).some(file => file.endsWith('local.txt')));
    assertBlocked();
    rmSync(path.join(dest, 'local.txt'));
    await assert.rejects(verifyClean({ ...task, box: 'none' }, run), /box must be mxc/);
    const alternate = path.join(dest, '.git', 'objects', 'info', 'alternates');
    writeFileSync(alternate, 'unused');
    await assert.rejects(verifyClean(task, run), /alternates/); assertBlocked(); rmSync(alternate);
    const worktree = path.join(root, 'linked'); git(dest, 'worktree', 'add', '-q', '--detach', worktree);
    const linkedManifest = path.join(root, 'linked-manifest.json');
    writeFileSync(linkedManifest, JSON.stringify({ ...JSON.parse(readFileSync(result.manifest, 'utf8')),
      dest: worktree }));
    await assert.rejects(verifyClean({ ...task, workspace: worktree, clean_room: { manifest: linkedManifest } },
      run), /\.git is not a directory/);
    assertBlocked({ workspace: worktree, clean_room: { manifest: linkedManifest } });
    const readRoot = path.join(root, 'read-root'); mkdirSync(readRoot);
    const large = path.join(readRoot, 'large'); writeFileSync(large, 'safe');
    fs.truncateSync(large, 64 * 1024 * 1024 + 1);
    const withLarge = await verifyClean({ ...task, read_roots: [readRoot] }, run);
    assert.ok(withLarge.large.includes(large)); rmSync(large);
    writeFileSync(path.join(readRoot, 'data'), 'forbidden-word-alpha');
    await assert.rejects(verifyClean({ ...task, read_roots: [readRoot] }, run), /forbidden term/);
    assertBlocked({ read_roots: [readRoot] });
    rmSync(path.join(readRoot, 'data'));
    const oldCommit = git(source, 'rev-list', '--max-parents=0', 'HEAD').trim();
    git(dest, 'fetch', '-q', source, oldCommit);
    await assert.rejects(verifyClean(task, run), /forbidden term/);
    assertBlocked();
    const controlTask = JSON.parse(readFileSync(taskFile, 'utf8')); delete controlTask.clean_room;
    writeFileSync(taskFile, JSON.stringify(controlTask));
    const control = runCli();
    try {
      assert.equal(control.status, 'completed', JSON.stringify(control));
      assert.equal(readFileSync(requestCount, 'utf8'), 'xxxxxxxx');
      assert.throws(() => readdirSync(path.join(control.run_dir, 'requests')));
    } finally { if (control.run_dir) rmSync(control.run_dir, { recursive: true, force: true }); }
    writeFileSync(path.join(source, 'bad.txt'), 'ＦＯＲＢＩＤＤＥＮ－ＷＯＲＤ－ＡＬＰＨＡ');
    git(source, 'add', '-A'); git(source, 'commit', '-qm', 'bad');
    const bad = path.join(root, 'bad');
    writeFileSync(declaration, JSON.stringify({ ...d, dest: bad, commit: git(source, 'rev-parse', 'HEAD').trim() }));
    assert.equal(cleanCopy(declaration).status, 'quarantined');
    assert.throws(() => readdirSync(bad));
  } finally {
    if (manifestDir) rmSync(manifestDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('copy detects filenames and UTF-16 bytes and rejects included symbolic links', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clean-entries-'));
  try {
    const source = path.join(root, 'source'); mkdirSync(source); git(source, 'init', '-q');
    const terms = path.join(root, 'terms'); writeFileSync(terms, 'forbidden-word-alpha\n');
    const file = path.join(root, 'declaration.json');
    const declaration = { id: 'test', source, dest: path.join(root, 'copy'), terms_file: terms,
      commit: '', include: ['**'], exclude: [] };
    const check = () => {
      declaration.commit = git(source, 'rev-parse', 'HEAD').trim();
      writeFileSync(file, JSON.stringify(declaration)); return cleanCopy(file);
    };
    writeFileSync(path.join(source, 'FORBIDDEN-WORD-ALPHA.txt'), 'safe');
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'name');
    const named = check();
    assert.equal(named.status, 'quarantined');
    assert.doesNotMatch(JSON.stringify(named).toLowerCase(), /forbidden-word-alpha/);
    rmSync(path.join(source, 'FORBIDDEN-WORD-ALPHA.txt'));
    writeFileSync(path.join(source, 'binary'), Buffer.from('forbidden-word-alpha', 'utf16le'));
    git(source, 'add', '-A'); git(source, 'commit', '-qm', 'binary');
    assert.equal(check().status, 'quarantined');
    rmSync(path.join(source, 'binary')); git(source, 'add', '-A');
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: source, input: 'target',
      encoding: 'utf8' }).trim();
    git(source, 'update-index', '--add', '--cacheinfo', `120000,${oid},link`);
    git(source, 'commit', '-qm', 'link');
    assert.throws(check, /Unsupported tree entry/);
    assert.throws(() => readdirSync(declaration.dest));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terms are regular expressions with comments, the same form as repository denylists', () => {
  const terms = readTerms('# a comment naming forbidden-word-alpha\n\nforbidden[-_]word\\b\n');
  assert.deepEqual(scanText('a FORBIDDEN_WORD here', terms), [3]);
  assert.deepEqual(scanText('a comment naming', terms), []);
  assert.deepEqual(scanText('forbidden-wordy', terms), []);
  assert.throws(() => readTerms('safe\nforbidden[\n'), /line 2 of the terms file/);
  const exact = readTerms('(?-i:(?<![A-Za-z])AB_)\n');
  assert.deepEqual(scanText('x AB_c', exact), [1]);
  assert.deepEqual(scanText('x ab_c', exact), []);
  assert.deepEqual(scanText('xAB_c', exact), []);
  assert.deepEqual(scanBytes(Buffer.from([0, 255, ...Buffer.from(' AB_')]), exact), [1]);
});

test('non-ASCII terms are found in binary data', () => {
  const terms = readTerms('禁止語\n');
  assert.deepEqual(scanBytes(Buffer.concat([Buffer.from([0, 255]), Buffer.from('禁止語')]), terms), [1]);
  assert.deepEqual(scanBytes(Buffer.from([0, 255, 1]), terms), []);
});

test('a copy with no ledger row is dropped so its number can be used again', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clean-crash-'));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('ok');
    const ledger = path.join(root, 'ledger.jsonl');
    const requests = path.join(root, 'requests'); mkdirSync(requests);
    writeFileSync(path.join(requests, '1.json.gz'), 'left by a crash before the ledger row');
    const restore = installGate({ cleanRoom: true, allowedHosts: ['localhost:1234'], model: 'test',
      effort: 'medium', tools: [], ledgerPath: ledger, maxQuotaPercent: 1 });
    try {
      const response = await fetch('http://localhost:1234/responses', { method: 'POST',
        body: JSON.stringify({ model: 'test', reasoning: { effort: 'medium' } }) });
      assert.equal(response.status, 200); await restore.flush();
    } finally { restore(); }
    const row = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(item => item.request_number === 1);
    assert.equal(hash(gunzipSync(readFileSync(path.join(requests, '1.json.gz')))), row.sha256);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('request receipts and audit detect tampering and extra files', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clean-gate-'));
  const original = globalThis.fetch;
  try {
    const terms = path.join(root, 'terms'); writeFileSync(terms, 'forbidden-word-alpha\n');
    writeFileSync(path.join(root, 'task.json'), JSON.stringify({ clean_room: {}, forbidden_terms_file: terms,
      read_roots: [], box: 'mxc' }));
    const ledger = path.join(root, 'ledger.jsonl');
    writeFileSync(ledger, JSON.stringify({ clean_room: { manifest_sha256: 'test' } }) + '\n');
    let received = 0; globalThis.fetch = async () => { received++; return new Response('ok'); };
    const restore = installGate({ cleanRoom: true, allowedHosts: ['localhost:1234'], model: 'test',
      effort: 'medium', tools: [], ledgerPath: ledger, maxQuotaPercent: 1 });
    try {
      await fetch('http://localhost:1234/responses', { method: 'POST',
        body: JSON.stringify({ model: 'test', reasoning: { effort: 'medium' }, input: 'safe' }) });
      await restore.flush();
    } finally { restore(); }
    assert.equal(received, 1);
    const receipt = path.join(root, 'requests', '1.json.gz');
    const row = JSON.parse(readFileSync(ledger, 'utf8').split('\n').find(line => line.includes('sha256') &&
      line.includes('request_number'))!);
    assert.equal(hash(gunzipSync(readFileSync(receipt))), row.sha256);
    assert.equal(audit(root).ok, true);
    writeFileSync(terms, 'safe\n'); assert.deepEqual(audit(root).forbidden, ['1.json.gz']);
    writeFileSync(terms, 'forbidden-word-alpha\n');
    const originalReceipt = readFileSync(receipt);
    const changed = Buffer.from(originalReceipt); changed[9] ^= 1;
    writeFileSync(receipt, changed); assert.deepEqual(gunzipSync(changed), gunzipSync(originalReceipt));
    assert.deepEqual(audit(root).mismatch, ['1.json.gz']);
    rmSync(receipt); assert.deepEqual(audit(root).missing, ['1.json.gz']);
    writeFileSync(receipt, originalReceipt); writeFileSync(path.join(root, 'requests', '2.json.gz'), 'extra');
    assert.deepEqual(audit(root).extra, ['2.json.gz']);
    writeFileSync(path.join(root, 'requests', '2.json.gz'), gzipSync(Buffer.from('{"text":"forbidden-word-alpha"}')));
    const extraAudit = audit(root);
    assert.deepEqual(extraAudit.extra, ['2.json.gz']);
    assert.deepEqual(extraAudit.forbidden, ['2.json.gz']);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('receipt failure stops the request and ordinary runs create no receipts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clean-failure-'));
  const originalFetch = globalThis.fetch; const originalOpen = fs.openSync;
  try {
    let received = 0; globalThis.fetch = async () => { received++; return new Response('ok'); };
    const config = { allowedHosts: ['localhost:1234'], model: 'test', effort: 'medium', tools: [],
      ledgerPath: path.join(root, 'ledger.jsonl'), maxQuotaPercent: 1 };
    const send = () => fetch('http://localhost:1234/responses', { method: 'POST',
      body: JSON.stringify({ model: 'test', reasoning: { effort: 'medium' } }) });
    let restore = installGate({ ...config, cleanRoom: true });
    fs.openSync = ((file: fs.PathLike, ...args: any[]) => {
      if (String(file).endsWith('.json.gz')) throw new Error('receipt unavailable');
      return (originalOpen as any)(file, ...args);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { await assert.rejects(send(), /receipt unavailable/); assert.equal(received, 0); }
    finally { fs.openSync = originalOpen; syncBuiltinESMExports(); restore(); }
    rmSync(path.join(root, 'requests'), { recursive: true, force: true });
    restore = installGate(config);
    try { await send(); await restore.flush(); assert.equal(received, 1); }
    finally { restore(); }
    assert.throws(() => readdirSync(path.join(root, 'requests')));
  } finally {
    fs.openSync = originalOpen; syncBuiltinESMExports(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('child and retried requests share the receipt sequence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clean-roles-'));
  const original = globalThis.fetch;
  try {
    let received = 0;
    globalThis.fetch = async () => new Response('', { status: ++received === 1 ? 503 : 200 });
    const ledger = path.join(root, 'ledger.jsonl');
    const restore = installGate({ cleanRoom: true, allowedHosts: ['localhost:1234'], ledgerPath: ledger,
      profiles: [{ model: 'parent', effort: 'medium', tools: [] }, { model: 'child', effort: 'low', tools: [] }],
      maxQuotaPercent: 1 });
    const send = (model: string, effort: string) => fetch('http://localhost:1234/responses', { method: 'POST',
      body: JSON.stringify({ model, reasoning: { effort } }) });
    const usage = () => ({ calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, quota_percent: 0 });
    try {
      assert.equal((await send('parent', 'medium')).status, 503);
      assert.equal((await send('parent', 'medium')).status, 200);
      await roleContext.run({ name: 'worker', usage: usage(), aggregate: usage(), limit: 1 },
        async () => { assert.equal((await send('child', 'low')).status, 200); });
      await restore.flush();
    } finally { restore(); }
    const rows = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(row => row.sha256);
    assert.deepEqual(rows.map(row => row.request_number), [1, 2, 3]);
    assert.deepEqual(readdirSync(path.join(root, 'requests')).sort(), ['1.json.gz', '2.json.gz', '3.json.gz']);
    assert.equal(received, 3);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test('export preserves the index and includes untracked binary data and deletions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clean-export-'));
  try {
    const work = path.join(root, 'work'); const target = path.join(root, 'target'); mkdirSync(work);
    git(work, 'init', '-q'); writeFileSync(path.join(work, 'delete'), 'old');
    writeFileSync(path.join(work, 'change'), 'before'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
    const head = git(work, 'rev-parse', 'HEAD').trim(); git(root, 'clone', '-q', work, target);
    const index = readFileSync(path.join(work, '.git', 'index'));
    rmSync(path.join(work, 'delete')); writeFileSync(path.join(work, 'change'), 'after');
    writeFileSync(path.join(work, 'binary'), Buffer.from([0, 255, 1]));
    // Ignored build output stays out of the patch, the same as a commit.
    writeFileSync(path.join(work, '.git', 'info', 'exclude'), 'obj/\n');
    mkdirSync(path.join(work, 'obj')); writeFileSync(path.join(work, 'obj', 'out.dll'), 'built');
    writeFileSync(path.join(root, 'task.json'), JSON.stringify({ workspace: work, box: 'mxc' }));
    writeFileSync(path.join(root, 'state.json'), JSON.stringify({ start: { head } }));
    const patch = path.join(root, 'out.patch'); const result = exportPatch(root, patch);
    assert.equal(result.files.length, 3); assert.deepEqual(readFileSync(path.join(work, '.git', 'index')), index);
    git(target, 'apply', '--binary', patch);
    assert.deepEqual(readFileSync(path.join(target, 'binary')), readFileSync(path.join(work, 'binary')));
    assert.equal(readFileSync(path.join(target, 'change'), 'utf8'), 'after');
    assert.throws(() => readFileSync(path.join(target, 'delete')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
