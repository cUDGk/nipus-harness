import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createWeb } from '../src/web.ts';
import { runLoop } from '../src/loop.ts';
import { createTools } from '../src/tools.ts';
import { prompt } from '../src/prompt.ts';

test('environment proxies cannot bypass lookup or intercept loopback', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-proxy-')); let proxyHits = 0; let directHits = 0;
  const proxy = http.createServer((req, res) => { proxyHits++; res.end('proxy'); });
  const direct = http.createServer((req, res) => { directHits++; res.setHeader('content-type', 'text/plain'); res.end('direct'); });
  await Promise.all([new Promise<void>(r => proxy.listen(0, '127.0.0.1', r)),
    new Promise<void>(r => direct.listen(0, '127.0.0.1', r))]);
  const pp = (proxy.address() as any).port; const dp = (direct.address() as any).port;
  try {
    const code = `import { createWeb } from ${JSON.stringify(new URL('../src/web.ts', import.meta.url).href)};
      let calls = 0;
      const lookup = (host, opts, cb) => { calls++; cb(null, [{address:'8.8.8.8',family:4},
        {address:'127.0.0.1',family:4}]); };
      const web = createWeb({}, ${JSON.stringify(dir)}, null, {lookup});
      const blocked = await web.fetch('http://example.com/');
      const direct = await createWeb({}, ${JSON.stringify(dir)}, null, {allowLoopback:true})
        .fetch('http://127.0.0.1:${dp}/');
      console.log(JSON.stringify({blocked, calls, direct}));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env,
      NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${pp}`, HTTPS_PROXY: `http://127.0.0.1:${pp}`,
      NO_PROXY: '', no_proxy: '' } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    const status = await new Promise(resolve => child.on('close', resolve)); assert.equal(status, 0, stderr);
    const result = JSON.parse(stdout); assert.equal(result.blocked.error, 'blocked_address');
    assert.ok(result.calls > 0); assert.equal(result.direct.text, 'direct');
    assert.equal(proxyHits, 0); assert.equal(directHits, 1);
  } finally {
    await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => direct.close(() => r()))]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web declaration controls tools and rejects unsafe startup before model requests', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-')); const taskFile = path.join(dir, 'task.json');
  const task = { id: 'web', goal: 'test', workspace: dir, model: 'gpt-6.1-terra', effort: 'medium', box: 'none',
    web: { search_url: 'http://127.0.0.1:9' } };
  try {
    const tools = createTools({ workspace: dir, readRoots: [], runDir: dir, finish: () => {} });
    assert.ok(!tools.some(tool => tool.name.startsWith('web_')));
    const enabled = createTools({ workspace: dir, readRoots: [], runDir: dir, finish: () => {},
      web: createWeb({}, dir), webFetch: true });
    assert.ok(enabled.some(tool => tool.name === 'web_search'));
    assert.ok(enabled.some(tool => tool.name === 'web_fetch'));
    assert.ok(!prompt('none').includes('Text from web_search'));
    assert.ok(prompt('none', true).includes('Text from web_search'));
    const run = (value: object) => { writeFileSync(taskFile, JSON.stringify(value));
      const child = spawnSync(process.execPath, [path.resolve('src/cli.ts'), 'run', taskFile],
        { encoding: 'utf8' });
      assert.equal(child.status, 1); return JSON.parse(child.stdout); };
    const unboxed = run(task); assert.equal(unboxed.status, 'failed');
    assert.match(unboxed.reason, /allow_unboxed/); assert.equal(unboxed.run_dir, null);
    const clean = run({ ...task, clean_room: { manifest: path.join(dir, 'missing') } });
    assert.equal(clean.status, 'quarantined'); assert.equal(clean.run_dir, null);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a worker can search, exhaust the shared budget, and finish', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-')); const agent = path.join(dir, 'agent');
  const requests: any[] = []; let searches = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/search')) { searches++; res.end(JSON.stringify({ results: [
      { title: 'example', url: 'https://example.com/', content: 'evidence' }] })); return; }
    let data = ''; req.on('data', chunk => { data += chunk; }); req.on('end', () => {
      requests.push(JSON.parse(data)); const n = requests.length;
      const name = n === 1 ? 'delegate' : [2, 4, 5, 7].includes(n) ? 'web_search' : 'finish';
      const args = name === 'delegate' ? { role: 'researcher', task: 'search' } : name === 'web_search' ?
        { query: `query${n}` } : { state: n === 6 ? 'blocked' : 'done', summary: 'done' };
      const item = { type: 'function_call', id: `item_${n}`, call_id: `call_${n}`, name,
        arguments: JSON.stringify(args), status: 'completed' };
      const response = { id: `response_${n}`, status: 'completed', output: [item],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
      const events = [{ type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const url = `http://127.0.0.1:${addr.port}`; const taskFile = path.join(dir, 'task.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'webtest', goal: 'search', workspace: dir, model: 'gpt-6.1-terra',
    effort: 'medium', box: 'none', max_quota_percent: 10, max_continues: 0, base_url: `${url}/v1`,
    roles: { researcher: { model: 'gpt-6.1-terra', effort: 'medium', tools: ['web_search', 'finish'],
      max_quota_percent: 10 } },
    web: { search_url: url, max_requests: 2, allow_unboxed: true, fetch: false } }));
  let runDir: string | undefined;
  try {
    const run = async (command: string, argument: string) => {
      const child = spawn(process.execPath, [path.resolve('src/cli.ts'), command, argument], { env: { ...process.env,
        HARNESS_AGENT_DIR: agent, HARNESS_TEST_API_KEY: 'fake-test-key', HARNESS_QUOTA_COMMAND: '' } });
      let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>(resolve => child.on('close', resolve));
      const result = JSON.parse(stdout); assert.equal(code, result.status === 'completed' ? 0 : 1, stderr);
      return result;
    };
    const first = await run('run', taskFile); runDir = first.run_dir;
    assert.equal(first.status, 'needs_judgment'); assert.equal(searches, 2); assert.equal(requests.length, 6);
    const declared = requests[0].tools ?? requests[0].input.find((item: any) => item.type === 'additional_tools').tools;
    assert.ok(declared.some((tool: any) => tool.name === 'web_search'));
    assert.ok(!declared.some((tool: any) => tool.name === 'web_fetch'));
    assert.ok(JSON.stringify(requests[5]).includes('web_budget_exhausted'));
    assert.ok(runDir); const resumed = await run('resume', runDir);
    assert.equal(resumed.status, 'completed'); assert.equal(searches, 2);
    assert.ok(JSON.stringify(requests[7]).includes('web_budget_exhausted'));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (runDir) rmSync(runDir, { recursive: true, force: true }); rmSync(dir, { recursive: true });
  }
});

test('search limits, records, filters, spacing, and budget across instances', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-')); const times: number[] = [];
  const server = http.createServer((_req, res) => {
    times.push(Date.now()); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ extra: 'outside-marker', results: Array.from({ length: 30 }, (_, i) => ({
      title: i === 0 ? 'blocked-word' : 'title', url: `https://example.com/${i}`,
      content: 'long-marker'.repeat(100), engine: 'unused' })), unresponsive_engines: ['x'] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const terms = path.join(dir, 'terms'); writeFileSync(terms, 'blocked-word\n');
  try {
    const config = { search_url: `http://127.0.0.1:${addr.port}`, max_requests: 2 };
    const web = createWeb(config, dir, terms);
    assert.deepEqual(await web.search('blocked-word'), { error: 'forbidden_term' });
    const one = await web.search('ordinary', 8); assert.ok('results' in one && one.results);
    assert.equal(one.results.length, 8); assert.equal(one.removed, 1); assert.equal(one.unresponsive, 1);
    assert.ok(one.results.every(row => row.snippet.length === 300));
    assert.ok(Buffer.byteLength(JSON.stringify(one)) <= 8192);
    assert.ok(!JSON.stringify(one).includes('outside-marker'));
    const kept = readFileSync(path.join(dir, 'logs', `${one.id}.log`), 'utf8');
    assert.ok(kept.includes('long-marker')); assert.ok(!kept.includes('blocked-word'));
    const plainDir = mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
    const plain = await createWeb({ search_url: config.search_url }, plainDir).search('ordinary');
    assert.ok('id' in plain); times.pop();
    const whole = readFileSync(path.join(plainDir, 'logs', `${plain.id}.log`), 'utf8');
    assert.ok(whole.includes('outside-marker')); assert.ok(whole.includes('blocked-word'));
    rmSync(plainDir, { recursive: true });
    const two = await web.search('again', 20); assert.ok('results' in two && two.results);
    assert.ok(Buffer.byteLength(JSON.stringify(two)) <= 8192); assert.ok(two.truncated);
    assert.ok(times[1] - times[0] >= 1900);
    assert.deepEqual(await createWeb(config, dir).search('third'), { error: 'web_budget_exhausted' });
    assert.equal(times.length, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});

test('unavailable search returns an error and leaves the next call usable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ results: [] })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  try {
    const web = createWeb({ search_url: `http://127.0.0.1:${addr.port}` }, dir);
    const result = await web.search('first'); assert.ok('error' in result);
    assert.equal(result.error, 'search_unavailable');
    await new Promise<void>(resolve => server.listen(addr.port, '127.0.0.1', resolve));
    const control = await web.search('second'); assert.ok('results' in control);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});

test('an interrupted request reservation remains spent after recreating the web tools', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
  try {
    writeFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify({ time: new Date().toISOString(),
      web_pending: 'interrupted' }) + '\n');
    const resumed = createWeb({ max_requests: 1 }, dir);
    assert.deepEqual(await resumed.search('query'), { error: 'web_budget_exhausted' });
    assert.deepEqual(await resumed.fetch('https://example.com/'), { error: 'web_budget_exhausted' });
  } finally { rmSync(dir, { recursive: true }); }
});

test('source evidence rejects invented and failed fetch ids, then accepts a successful fetch', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain');
    res.statusCode = req.url === '/failure' ? 404 : 200; res.end('evidence'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  try {
    const web = createWeb({}, dir, null, { allowLoopback: true });
    const failed = await web.fetch(`http://127.0.0.1:${addr.port}/failure`);
    assert.ok(!('id' in failed));
    const fetched = await web.fetch(`http://127.0.0.1:${addr.port}/success`);
    assert.ok('id' in fetched && fetched.id);
    let finish: any; let listener: (event: any) => void = () => {}; const messages: string[] = [];
    const session = { messages: [], subscribe: (fn: typeof listener) => { listener = fn; return () => {}; },
      prompt: async (message: string) => { messages.push(message); finish = { state: 'done', summary: 'done',
        answers: [{ id: 'q', conclusion: 'yes', status: 'confirmed', evidence: [messages.length === 1 ?
          'web:00000000-0000-0000-0000-000000000000' : fetched.id] }] }; listener({ type: 'agent_settled' }); } };
    const result = { status: '', state: null, summary: '', reason: null, checks: [],
      diff: { files: [], added: 0, deleted: 0 }, violations: [], continues: 0 };
    await runLoop(session as any, { goal: 'test', workspace: dir, questions: [{ id: 'q', text: 'q', sources: 1 }] },
      dir, result, () => finish, () => { finish = undefined; }, null, async () => {}, () => {});
    assert.equal(result.status, 'completed'); assert.equal(messages.length, 2);
    assert.match(messages[1], /needs 1 fetched sources.*found 0/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});

test('fetch rejects unsafe targets and validates every resolved address and redirect', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-')); let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'text/plain');
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/' }); res.end(); }
    else if (req.url?.startsWith('/hop')) { const n = Number(req.url.slice(4));
      res.writeHead(302, { location: `/hop${n + 1}` }); res.end(); }
    else res.end('control'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const web = createWeb({}, dir);
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/', 'http://172.16.0.1/',
      'http://192.168.1.1/', 'http://100.64.0.1/', 'http://169.254.169.254/', 'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'file:///tmp/a', 'ftp://example.com/',
      'http://example.com:8080/', 'http://user:password@example.com/']) {
      assert.ok('error' in await web.fetch(url), url);
    }
    const mixed = ((_host: string, _opts: unknown, cb: Function) => cb(null, [
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])) as typeof dns.lookup;
    assert.ok('error' in await createWeb({}, dir, null, { lookup: mixed }).fetch('http://example.com/'));
    assert.equal(hits, 0);
    const get = http.get;
    try {
      http.get = ((url: URL, opts: any, callback: any) => {
        assert.equal(url.hostname, '8.8.8.8');
        return get(new URL(`${base}/redirect`), opts, callback);
      }) as typeof http.get;
      const redirect = await web.fetch('http://8.8.8.8/redirect');
      assert.ok('error' in redirect); assert.equal(hits, 1);
    } finally { http.get = get; }
    hits = 0;
    const control = createWeb({}, dir, null, { allowLoopback: true });
    const result = await control.fetch(base); assert.ok('text' in result); assert.equal(result.text, 'control');
    assert.equal(hits, 1);
    const redirect = await control.fetch(`${base}/hop0`); assert.ok('error' in redirect);
    assert.equal(redirect.error, 'too_many_redirects'); assert.equal(hits, 7);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});

test('a lost connection and crafted pages end at once, and long lines stay readable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/upgrade') {
      res.socket!.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
      setTimeout(() => res.socket?.destroy(), 50); return;
    }
    if (req.url === '/lost') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.write(gzipSync(Buffer.alloc(100000, 65)).subarray(0, 20));
      setTimeout(() => res.destroy(), 50); return;
    }
    if (req.url === '/long') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('y'.repeat(3000)); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/tags') res.end('<p'.repeat(2000000));
    else if (req.url === '/open') res.end('visible<script'.repeat(300000));
    else if (req.url === '/meta') res.end('<meta '.repeat(800000));
    else res.end('one < two<p>three<!-- hidden --><script>hidden</script>four');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const web = createWeb({}, dir, null, { allowLoopback: true });
    const limit = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('took too long')), 10000))]);
    assert.ok('error' in await limit(web.fetch(`${base}/lost`)));
    assert.ok('error' in await limit(web.fetch(`${base}/upgrade`)));
    for (const page of ['/tags', '/open', '/meta']) assert.ok('id' in await limit(web.fetch(base + page)), page);
    const plain = await web.fetch(`${base}/plain`);
    assert.ok('text' in plain); assert.equal(plain.text, 'one < two\nthreefour');
    const long = await web.fetch(`${base}/long`); assert.ok('id' in long && long.id);
    const lines = readFileSync(path.join(dir, 'logs', `${long.id.slice(4)}.log`), 'utf8').split('\n');
    assert.ok(lines.length > 1 && lines.every(line => line.length <= 400));
    assert.equal(lines.join(''), 'y'.repeat(3000));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});

test('fetch decodes compressed text, strips HTML, limits decompressed bytes, and filters content', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-test-')); let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/image') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('image'); return; }
    if (req.url === '/secret') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('blocked-word'); return; }
    if (req.url === '/sjis' || req.url === '/meta') {
      res.writeHead(200, { 'content-type': req.url === '/sjis' ? 'text/plain; charset=Shift_JIS' : 'text/html' });
      res.end(Buffer.concat([Buffer.from(req.url === '/meta' ? '<meta charset="Shift_JIS"><p>' : ''),
        Buffer.from([0x93, 0xfa, 0x96, 0x7b])])); return;
    }
    if (req.url === '/euc') { res.writeHead(200, { 'content-type': 'text/plain; charset=EUC-JP' });
      res.end(Buffer.from([0xc6, 0xfc, 0xcb, 0xdc])); return; }
    if (req.url === '/huge') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(6 * 1024 * 1024, 65))); return; }
    const html = Buffer.from('<head>hidden</head><p>Hello &amp; &#x41;</p><script>evil</script>');
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': req.url === '/br' ? 'br' : 'gzip' });
    res.end(req.url === '/br' ? brotliCompressSync(html) : gzipSync(html));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`; const terms = path.join(dir, 'terms');
  writeFileSync(terms, 'blocked-word\n');
  try {
    const web = createWeb({}, dir, terms, { allowLoopback: true });
    for (const endpoint of ['/gzip', '/br']) {
      const result = await web.fetch(base + endpoint); assert.ok('text' in result);
      assert.equal(result.text, 'Hello & A'); assert.ok(result.id);
    }
    for (const endpoint of ['/sjis', '/euc', '/meta']) {
      const result = await web.fetch(base + endpoint); assert.ok('text' in result);
      assert.equal(result.text, '\u65e5\u672c');
    }
    const huge = await web.fetch(base + '/huge'); assert.ok('total_chars' in huge);
    assert.equal(huge.total_chars, 5 * 1024 * 1024); assert.equal(huge.truncated, true);
    assert.deepEqual(await web.fetch(base + '/image'), { error: 'unsupported_type', content_type: 'image/png' });
    const files = readdirSync(path.join(dir, 'logs'));
    assert.deepEqual(await web.fetch(base + '/secret'), { error: 'forbidden_term' });
    assert.deepEqual(readdirSync(path.join(dir, 'logs')), files);
    assert.deepEqual(await web.fetch(base + '/blocked-word'), { error: 'forbidden_term' });
    assert.equal(hits, 8);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});
