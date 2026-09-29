import { randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hash } from 'bcryptjs';

type Variant = 'blank' | 'demo';
type Options = {
  variant: Variant;
  instanceDir?: string;
  envPath?: string;
  appUrl?: string;
  dexIssuer?: string;
  listenPort?: number;
  databasePort?: number;
};

const root = process.cwd();
const defaults = {
  appUrl: 'http://127.0.0.1:4310',
  dexPort: 5558,
  databasePort: 54329,
};

function usage(): never {
  console.log(`Usage: bun run local:setup [options]

Without options, preserve the original local files (.env and .local).
Options:
  --variant blank|demo       Identity set (default: demo)
  --instance-dir PATH        New private state directory for an isolated instance
  --env-path PATH            Environment file (default: INSTANCE/.env)
  --app-url URL               Application origin (default: http://127.0.0.1:4310)
  --dex-issuer URL            Dex issuer (default: http://127.0.0.1:5558/dex)
  --listen-port PORT          Loopback Dex HTTP port (default: 5558)
  --database-port PORT        Loopback PostgreSQL port (default: 54329)
  --help`);
  process.exit(0);
}

function port(value: string, name: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error(`${name} must be an integer from 1 to 65535.`);
  return result;
}

function parseArgs(argv: string[]): Options {
  const result: Options = { variant: 'demo' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') usage();
    const [name, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    switch (name) {
      case '--variant':
        if (value !== 'blank' && value !== 'demo') throw new Error('--variant must be blank or demo.');
        result.variant = value;
        break;
      case '--instance-dir': result.instanceDir = value; break;
      case '--env-path': result.envPath = value; break;
      case '--app-url': result.appUrl = value; break;
      case '--dex-issuer': result.dexIssuer = value; break;
      case '--listen-port':
        result.listenPort = port(value, 'listen port');
        break;
      case '--database-port': result.databasePort = port(value, 'database port'); break;
      default: throw new Error(`Unknown option ${name}. Use --help for usage.`);
    }
  }
  return result;
}

function origin(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be an absolute http or https URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${label} must use HTTP(S) without credentials, query, or fragment.`);
  return parsed.href.replace(/\/+$/, '');
}

const options = parseArgs(process.argv.slice(2));
const isolated = options.instanceDir !== undefined;
const stateDir = resolve(root, options.instanceDir ?? '.local');
const envPath = resolve(root, options.envPath ?? (isolated ? `${options.instanceDir}/.env` : '.env'));
const appUrl = origin(options.appUrl ?? defaults.appUrl, 'app URL');
const parsedAppUrl = new URL(appUrl);
if (parsedAppUrl.pathname !== '/') throw new Error('app URL must be an origin without a path.');
const appPort = parsedAppUrl.port || (parsedAppUrl.protocol === 'https:' ? '443' : '80');
const listenPort = options.listenPort ?? defaults.dexPort;
const databasePort = options.databasePort ?? defaults.databasePort;
const dexIssuer = origin(options.dexIssuer ?? `http://127.0.0.1:${listenPort}/dex`, 'Dex issuer');
const credentialsPath = resolve(stateDir, 'credentials.json');
const dexDir = resolve(stateDir, 'dex');
const dexConfigPath = resolve(dexDir, 'config.yaml');
const pg0Home = resolve(stateDir, 'pg0-home');

if (isolated) {
  await mkdir(dirname(stateDir), { recursive: true, mode: 0o700 });
  try { await mkdir(stateDir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${stateDir} already exists; refusing to overwrite this instance.`);
    throw error;
  }
} else {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}
await chmod(stateDir, 0o700);
await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
for (const file of [envPath, credentialsPath, dexConfigPath]) {
  try { await access(file); throw new Error(`${file} already exists; refusing to overwrite credentials. Use the existing environment.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

const adminEmail = 'goalie-admin@example.test';
const databasePassword = randomBytes(24).toString('base64url');
const clientSecret = randomBytes(24).toString('base64url');
const password = () => randomBytes(24).toString('base64url');
const users = options.variant === 'blank'
  ? [{ email: adminEmail, username: 'Workspace administrator', role: 'admin', userID: randomUUID(), password: password() }]
  : [
    { email: adminEmail, username: 'Alex Morgan', role: 'admin', userID: randomUUID(), password: password() },
    { email: 'goalie-editor@example.test', username: 'Sam Rivera', role: 'editor', userID: randomUUID(), password: password() },
    { email: 'goalie-viewer@example.test', username: 'Taylor Chen', role: 'viewer', userID: randomUUID(), password: password() },
  ];

await mkdir(dexDir, { recursive: true, mode: 0o700 });

await mkdir(pg0Home, { recursive: true, mode: 0o700 });
await chmod(pg0Home, 0o700);
await chmod(dexDir, 0o700);

async function atomicPrivate(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} already exists; refusing to overwrite credentials.`);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(path, 0o600);
}

const dex = {
  issuer: dexIssuer,
  storage: { type: 'sqlite3', config: { file: '/data/dex.db' } },
  web: { http: `127.0.0.1:${listenPort}` },
  oauth2: { skipApprovalScreen: true },
  staticClients: [{ id: 'goalie', name: 'Goalie local development', secret: clientSecret, redirectURIs: [`${appUrl}/auth/callback`] }],
  enablePasswordDB: true,
  staticPasswords: await Promise.all(users.map(async ({ password: plain, role: _role, ...user }) => ({ ...user, hash: await hash(plain, 12) }))),
};
await atomicPrivate(dexConfigPath, JSON.stringify(dex, null, 2));
await atomicPrivate(credentialsPath, JSON.stringify({ users }, null, 2));
await atomicPrivate(envPath, [
  'NODE_ENV=development', `APP_URL=${appUrl}`, `PORT=${appPort}`,
  `DATABASE_URL=postgresql://goalie:${encodeURIComponent(databasePassword)}@127.0.0.1:${databasePort}/goalie`,
  `OIDC_ISSUER=${dexIssuer}`, 'OIDC_CLIENT_ID=goalie', `OIDC_CLIENT_SECRET=${clientSecret}`,
  `AUTH_BOOTSTRAP_EMAIL=${adminEmail}`,
  'OPENJEV_ENABLED=false', 'OPENJEV_BASE_URL=', 'OPENJEV_TRUSTED_ORIGIN=', 'OPENJEV_API_KEY_FILE=', 'OPENJEV_MODEL=openjev-latest', 'OPENJEV_TIMEOUT_MS=30000', '',
].join('\n'));

const relativeState = stateDir === resolve(root, '.local') ? '.local' : stateDir;
console.log(`Created ${envPath}, ${dexConfigPath}, and ${credentialsPath} with private permissions.`);
console.log(`Instance state: ${relativeState}. No passwords printed.`);
console.log('No business records were seeded. Next: start pg0 and Dex, run db:migrate, then explicitly run db:seed-work only for a demo instance.');
