import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const server = await createServer();
await server.listen();
const electron = spawn(require('electron'), ['.'], {stdio:'inherit', env: {...process.env, REVIEWOPS_DEV_URL:'http://127.0.0.1:5173'}});
electron.on('exit', async code => { await server.close(); process.exit(code || 0); });
process.on('SIGINT', () => electron.kill('SIGINT'));
