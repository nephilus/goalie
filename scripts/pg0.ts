import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Pool } from 'pg';
import { parseEnv } from 'node:util';

type Options = { instanceDir?: string; envPath?: string; name?: string };

function parseArgs(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      console.log('Usage: bun run db:start -- [--instance-dir PATH] [--env-path PATH] [--name NAME]');
      process.exit(0);
    }
    const [name, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--instance-dir') options.instanceDir = value;
    else if (name === '--env-path') options.envPath = value;
    else if (name === '--name') options.name = value;
    else throw new Error(`Unknown option ${name}. Use --help for usage.`);
  }
  return options;
}

const root = process.cwd();
const options = parseArgs(process.argv.slice(2));
const stateDir = resolve(root, options.instanceDir ?? '.local');
const envPath = resolve(root, options.envPath ?? (options.instanceDir ? `${options.instanceDir}/.env` : '.env'));
let instanceEnv: NodeJS.ProcessEnv;
try { instanceEnv = parseEnv(await readFile(envPath, 'utf8')); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Environment file ${envPath} does not exist; run local:setup first.`);
  throw error;
}

let database: URL;
try { database = new URL(instanceEnv.DATABASE_URL ?? ''); }
catch { throw new Error(`DATABASE_URL in ${envPath} is not a valid URL.`); }
if (!['127.0.0.1', 'localhost'].includes(database.hostname)) throw new Error('pg0 launcher only manages a local loopback database. PGaaS must be managed separately.');
if (!database.username || !database.password || !database.port || database.pathname !== '/goalie') throw new Error(`Configure DATABASE_URL in ${envPath} with a username, password, explicit port and /goalie database.`);

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);
const home = resolve(stateDir, 'pg0-home');
const dataDir = resolve(stateDir, 'pgdata');
await mkdir(home, { recursive: true, mode: 0o700 });
await chmod(home, 0o700);
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
const logPath = resolve(stateDir, 'pg0-launch.log');
const log = await open(logPath, 'a', 0o600);
await chmod(logPath, 0o600);
const processName = options.name ?? (options.instanceDir ? `goalie-${basename(stateDir).replace(/[^a-zA-Z0-9_-]/g, '-')}` : 'goalie');
const childEnv = { ...process.env, ...instanceEnv, HOME: home };
const run = (args: string[]) => new Promise<void>((accept, reject) => {
  const child = spawn('pg0', args, { env: childEnv, stdio: ['ignore', log.fd, log.fd] });
  child.once('error', error => reject(new Error(`Could not start pg0 (${(error as NodeJS.ErrnoException).code ?? 'spawn failure'}). Install pg0 and ensure it is on PATH.`)));
  child.once('exit', code => code === 0 ? accept() : reject(new Error(`pg0 exited ${code}; inspect private ${logPath}`)));
});
await run(['start', '--name', processName, '--port', database.port, '--data-dir', dataDir, '--username', decodeURIComponent(database.username), '--password', decodeURIComponent(database.password), '--database', 'goalie', '-c', 'listen_addresses=127.0.0.1', '-c', 'shared_buffers=128MB', '-c', 'work_mem=4MB', '-c', 'maintenance_work_mem=64MB', '-c', 'max_connections=30']);
const pool = new Pool({ connectionString: database.toString(), max: 1, connectionTimeoutMillis: 2000 });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  await pool.end();
  try { await run(['stop', '--name', processName]); } finally { await log.close(); }
};
const keepAlive = setInterval(() => { void pool.query('select 1').catch(() => { console.error('pg0 health check failed; stopping supervisor.'); void stop().finally(() => process.exit(1)); }); }, 10_000);
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
try { await pool.query('select 1'); console.log(`pg0 ready on 127.0.0.1:${database.port}; persistent data ${dataDir}`); }
catch { await stop(); throw new Error(`Local PostgreSQL did not accept the configured credentials from ${envPath}. Check the private pg0 log.`); }
