import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { onPath } from './boxed/which.mjs';

export const appName = 'Nipus-harness';
export const defaultAgentDir = path.resolve(import.meta.dirname, '../.agent');

// Registers the harness with Sign in with ChatGPT under its own name and keeps the token in a folder only this
// user and SYSTEM can open. The consent URL goes to a file in that folder; no token is ever printed.
export async function login(agentDir = defaultAgentDir) {
  mkdirSync(agentDir, { recursive: true });
  if (!process.env.USERNAME) throw new Error('USERNAME is not set');
  execFileSync(onPath('icacls'), [agentDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F',
    `${process.env.USERNAME}:(OI)(CI)F`], { stdio: 'ignore' });
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
    refreshOnCreate: false });
  const settings = SettingsManager.create(agentDir, agentDir);
  await runtime.login('openai', 'oauth', {
    signal: AbortSignal.timeout(10 * 60 * 1000),
    notify(event) {
      if (event.type === 'auth_url') {
        writeFileSync(path.join(agentDir, 'login_url.txt'), event.url);
        console.log('AUTH_URL_READY');
      } else if (event.type === 'progress') console.log('progress', event.message);
    },
    // The local callback server finishes the login, so the manual-paste prompt only waits to be cancelled.
    prompt: ({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('prompt cancelled')), { once: true });
    }),
  }, { getDeviceId: () => settings.getOrCreateDeviceId(), agentName: appName });
  await settings.flush?.();
  const models = (await runtime.getAvailable('openai')).map(model => model.id).filter(id => id.includes('gpt-6'));
  console.log('LOGIN_OK', JSON.stringify(models));
}
