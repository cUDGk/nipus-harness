import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { onPath } from './which.mjs';

const gitFile = onPath('git');
const git = (...args) => {
  try { return execFileSync(gitFile, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c',
    'diff.external=', '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_GLOBAL: 'NUL', GIT_LITERAL_PATHSPECS: '1' }, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (error.stderr) error.message = String(error.stderr); throw error; }
  };
const [mode, head, output] = process.argv.slice(2);
const emit = value => writeFileSync(output, JSON.stringify(value));
const hash = data => createHash('sha256').update(data).digest('hex');
const entries = value => value.split('\0').filter(Boolean);
if (mode === 'state') {
  // Identifies what a host job ran against. Ignored files count too, by size and time because they can be many and
  // large: a check can read an ignored config, and a pass must not outlive a change to it.
  let revision;
  try { revision = git('rev-parse', '--verify', 'HEAD').trim(); }
  catch {
    const files = [];
    const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory() && !(dir === '.' && entry.name === '.git')) walk(name);
      else if (entry.isFile()) files.push([name, hash(readFileSync(name))]);
    } };
    walk('.');
    emit({ repository: false, content: hash(JSON.stringify(files)) });
    process.exit(0);
  }
  const bytes = name => existsSync(name) && lstatSync(name).isFile() ? hash(readFileSync(name)) : null;
  const changed = entries(git('diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', revision, '--'));
  const untracked = entries(git('ls-files', '-o', '--exclude-standard', '-z'));
  const ignored = entries(git('ls-files', '-o', '-i', '--exclude-standard', '-z')).map(name => {
    try { const stat = lstatSync(name); return [name, stat.size, stat.mtimeMs]; }
    catch { return [name, null, null]; }
  });
  const content = [revision, changed.map(name => [name, bytes(name)]), untracked.map(name => [name, bytes(name)])];
  emit({ repository: true, state: hash(JSON.stringify([...content, ignored])), content: hash(JSON.stringify(content)) });
} else if (mode === 'start') {
  let revision;
  try { revision = git('rev-parse', '--verify', 'HEAD').trim(); }
  catch (error) {
    try { git('rev-parse', '--git-dir'); throw new Error('Repository has no HEAD'); }
    catch (e) {
      if (/not a git repository/i.test(e.message) && !existsSync('.git')) {
        emit({ repository: false }); process.exit(0);
      }
      console.error(e.message === 'Repository has no HEAD' ? e.message : error.message); process.exit(1);
    }
  }
  emit({ repository: true, head: revision, dirty: !!git('status', '--porcelain', '-z',
    '--untracked-files=all') });
} else {
  let num = git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', head, '--');
  let patch = git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', '--no-color', head, '--');
  // .gitattributes or one NUL byte can make git call any text file binary, which would hide its lines from the checks.
  // A file with a source extension, or whose bytes are valid UTF-8, is compared again as text.
  const source = /\.(?:[cm]?[jt]sx?|cs|py|rs|go|java|c|h|cc|cpp|hpp|lua|ps1|sh|md|json|toml|ya?ml|xml|html?|css|shader|cginc|hlsl|asmdef|uxml|uss)$/i;
  const looksText = name => {
    if (!existsSync(name) || lstatSync(name).size > 16 * 1024 * 1024) return false;
    if (source.test(name)) return true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(name)); return true; }
    catch { return false; }
  };
  const hidden = entries(num).filter(item => item.startsWith('-\t-\t')).map(item => item.slice(4)).filter(looksText);
  if (hidden.length) {
    const counted = hidden.map(name => {
      // --text changes the patch but not --numstat, so the lines are counted from the patch.
      const text = git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--text', '--unified=0',
        '--no-color', head, '--', name);
      patch += text;
      const rows = text.split('\n');
      const body = rows.slice(rows.findIndex(row => row.startsWith('@@')));
      const count = mark => body.filter(row => row.startsWith(mark)).length;
      return `${count('+')}\t${count('-')}\t${name}`;
    });
    num = [...entries(num).filter(item => !(item.startsWith('-\t-\t') && hidden.includes(item.slice(4)))),
      ...counted].join('\0') + '\0';
  }
  const added = git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '--diff-filter=A',
    '-z', head, '--').split('\0').filter(Boolean);
  const untracked = git('ls-files', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean).map(path => {
    return { path, content: looksText(path) ? new TextDecoder('utf-8').decode(readFileSync(path)) : null };
  });
  const dependencies = {};
  const names = [...num.split('\0').map(item => item.split('\t')[2])
    .filter(name => name && /(^|\/)package\.json$/.test(name)),
  ...untracked.map(item => item.path).filter(name => /(^|\/)package\.json$/.test(name))];
  for (const name of names) {
    try {
      let before = {};
      try { before = JSON.parse(git('show', `${head}:${name}`)); } catch { /* New package. */ }
      const after = existsSync(name) ? JSON.parse(readFileSync(name, 'utf8')) : {};
      dependencies[name] = ['dependencies',
        'devDependencies'].some(key => JSON.stringify(before[key] ?? {}) !== JSON.stringify(after[key] ?? {}));
    } catch { /* Deleted or invalid manifest. */ }
  }
  const tomlDependencies = text => {
    const selected = []; let section = ''; let array = false;
    for (const line of text.split('\n')) {
      const heading = /^\s*\[([^\]]+)\]/.exec(line);
      if (heading) { section = heading[1]; array = false; }
      if (/(^|\.)(?:dependencies|dev-dependencies|build-dependencies|optional-dependencies|dependency-groups)$/
        .test(section) || (/^tool\.poetry\.(?:group\.[^.]+\.)?(?:dependencies|dev-dependencies)$/.test(section))) {
        selected.push(line);
      } else if (section === 'project' && (/^\s*dependencies\s*=/.test(line) || array)) {
        selected.push(line); array = !line.includes(']');
      }
    }
    return selected.join('\n');
  };
  const manifests = [...num.split('\0').map(item => item.split('\t')[2]).filter(Boolean),
    ...untracked.map(item => item.path)].filter(name => /(^|\/)(Cargo|pyproject)\.toml$/.test(name));
  for (const name of manifests) {
    let before = ''; try { before = git('show', `${head}:${name}`); } catch { /* New manifest. */ }
    const after = existsSync(name) ? readFileSync(name, 'utf8') : '';
    dependencies[name] = tomlDependencies(before) !== tomlDependencies(after);
  }
  const opaque = [...entries(num).filter(item => item.startsWith('-\t-\t')).map(item => item.slice(4)),
    ...untracked.filter(item => item.content === null).map(item => item.path)]
    .filter(name => source.test(name) && existsSync(name) && lstatSync(name).size > 16 * 1024 * 1024);
  // git lists a repository made inside the workspace as one folder and shows nothing of its files.
  const nested = untracked.map(item => item.path).filter(name => name.endsWith('/'));
  emit({ num, patch, untracked, added, dependencies, opaque, nested });
}
