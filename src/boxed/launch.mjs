import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { onPath } from './which.mjs';

const { command, env } = JSON.parse(readFileSync(process.argv[2], 'utf8'));

// .NET resolves its local folder under USERPROFILE using the per-run sandbox GUID. While that
// folder is missing it returns an empty path and NuGet writes into the current folder.
const profile = /\\AppData\\Local\\(Packages\\.+)$/i.exec(process.env.LOCALAPPDATA ?? '')?.[1];
if (profile && env.USERPROFILE) mkdirSync(path.join(env.USERPROFILE, 'AppData', 'Local', profile), { recursive: true });

const merged = { ...process.env, ...env };
let file;
try { file = onPath(command[0], merged); }
catch (error) { console.error(error.message); process.exit(1); }
const result = spawnSync(file, command.slice(1), { stdio: 'inherit', env: merged, windowsHide: true });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
