import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// Windows looks in the current folder before PATH, and the worker controls the current folder: a git.exe or
// powershell.exe placed there would replace a check or run with the owner's rights. So a program name always becomes
// a full path taken from PATH alone before it starts. .cmd and .bat are left out because they need a shell.
export function onPath(name, env = process.env) {
  if (path.isAbsolute(name)) return name;
  if (/[\\/]/.test(name)) throw new Error(`Program must be a name or a full path: ${name}`);
  const key = Object.keys(env).find(item => item.toUpperCase() === 'PATH');
  const names = path.extname(name) ? [name] : [`${name}.exe`, `${name}.com`];
  for (const dir of (key ? env[key] : '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    for (const item of names) {
      const full = path.join(dir, item);
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
  }
  throw new Error(`Program not found on PATH: ${name}`);
}
