import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
import { spawn } from 'node:child_process';
const names = ['echo', 'image', 'long', 'fail', 'slow', 'die', 'environment', 'ask', 'rpcfail', 'rpcodd', 'helper', 'patterned'];
// Stays alive after its input closes, as a server that ignores the end of stdin would.
if (process.argv.includes('stubborn')) setInterval(() => {}, 1000);
let asking;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  // The client's answer to the ping below, which ends the call that started it.
  if (!msg.method && msg.id === asking && msg.result) {
    send({ jsonrpc: '2.0', id: asking, result: { content: [{ type: 'text', text: 'pong-seen' }] } });
    asking = undefined;
    return;
  }
  if (!msg.id) return;
  if (msg.method === 'initialize') {
    if (process.argv.includes('hang')) return;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
  } else if (msg.method === 'tools/list') {
    // A list that never ends, as a broken server could send.
    if (process.argv.includes('endless')) { send({ jsonrpc: '2.0', id: msg.id, result: { tools: Array.from({ length: 1000 }, (_, i) => ({ name: `t${i}` })), nextCursor: 'more' } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: names.map(name => ({ name, description: name, inputSchema: name === 'patterned'
      ? { type: 'object', properties: { pattern: { type: 'string', pattern: '^(a+)+$' }, other: { type: 'string' } }, patternProperties: { '^x': { type: 'string' } } }
      : { type: 'object', properties: {} } })) } });
  } else if (msg.method === 'tools/call') {
    const name = msg.params.name;
    if (name === 'slow') return;
    if (name === 'die') return process.exit(23);
    // A server's own request. Its id is the same number as the call on purpose: the two id spaces are separate.
    if (name === 'ask') { asking = msg.id; send({ jsonrpc: '2.0', id: msg.id, method: 'ping' }); return; }
    if (name === 'rpcfail') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad arg canary' } }); return; }
    if (name === 'rpcodd') { send({ jsonrpc: '2.0', id: msg.id, error: { message: { toString: null } } }); return; }
    // A helper cut loose from this server, which a clean exit of the server alone would leave behind.
    if (name === 'helper') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(child.pid) }] } });
      return;
    }
    let content = [{ type: 'text', text: JSON.stringify(msg.params.arguments) }];
    if (name === 'image') content = [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }];
    if (name === 'long') content = [{ type: 'text', text: 'long\n'.repeat(4000) }];
    if (name === 'environment') content = [{ type: 'text', text: JSON.stringify({ secret: process.env.FAKE_SECRET, allowed: process.env.ALLOWED, cwd: process.cwd(), database: process.env.DATABASE_URL, connection: process.env.FAKE_CONNECTION_STRING }) }];
    send({ jsonrpc: '2.0', id: msg.id, result: { content, isError: name === 'fail' } });
  }
});
