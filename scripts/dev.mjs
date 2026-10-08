import { spawn } from 'node:child_process';
const processes = [
  spawn(process.execPath, ['server/index.cjs'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '3001' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], { stdio: 'inherit' }),
];
let exiting = false;
function stop(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const child of processes) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of processes) child.on('exit', code => stop(code || 0));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
