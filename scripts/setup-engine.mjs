import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../vendor/forceteki/', import.meta.url));
if (!existsSync(`${cwd}/package-lock.json`)) throw new Error('Missing vendored Forceteki engine. Restore vendor/forceteki from the project.');
for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'build']]) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
