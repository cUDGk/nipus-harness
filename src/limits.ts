import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexExecutable } from './box.ts';

// Prints the rate limits of the account without calling a model, through the app server of the Codex CLI. A model call
// made while the weekly window is full is paid from credits, so the harness has to know before it sends one.
const server = spawn(codexExecutable(), ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const send = (message: object) => server.stdin.write(JSON.stringify(message) + '\n');
const end = (code: number, text: string) => {
  (code ? process.stderr : process.stdout).write(text + '\n', () => { server.kill(); process.exit(code); });
};
// The gate waits 30 seconds for this program, and it should hear why rather than just kill it.
setTimeout(() => end(1, 'codex app-server did not answer'), 25000).unref();
server.on('error', error => end(1, error.message));
server.on('exit', () => end(1, 'codex app-server ended before answering'));
createInterface({ input: server.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.error) end(1, JSON.stringify(message.error));
  else if (message.id === 1) {
    send({ method: 'initialized' });
    send({ id: 2, method: 'account/rateLimits/read' });
  } else if (message.id === 2) end(0, JSON.stringify(message.result));
});
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'nipus-harness', version: '1' } } });
