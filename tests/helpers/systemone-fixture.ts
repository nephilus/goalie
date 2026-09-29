import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { ASSESSMENT_QUESTIONS, type AssessmentLabels } from '../../app/shared/work-assessment';

const MAX_BODY_BYTES = 65_536;
type FixtureMode = 'valid' | 'hold' | 'http_error' | 'malformed' | 'invalid_choice';
const VALID_MODES: Record<FixtureMode, true> = { valid: true, hold: true, http_error: true, malformed: true, invalid_choice: true };
type CapturedRequest = { request: unknown; held: boolean };
type Held = { response: ServerResponse; request: Record<string, unknown> };

export type SystemOneFixture = {
  origin: string;
  close: () => Promise<void>;
  control: (value: { mode: FixtureMode; labelsByItemTitle?: Record<string, AssessmentLabels> }) => Promise<void>;
  requests: () => Promise<CapturedRequest[]>;
  waitForRequests: (count: number) => Promise<CapturedRequest[]>;
  release: () => Promise<void>;
};

function json(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { statusCode: 413 });
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}

function bearerAuthorized(request: IncomingMessage, apiKey: string): boolean {
  return request.headers.authorization === `Bearer ${apiKey}`;
}

function recordObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function itemTitleFromRequest(request: Record<string, unknown>): string | null {
  const state = request.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const item = (state as Record<string, unknown>).item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const title = (item as Record<string, unknown>).title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

function answerFor(question: Record<string, unknown>, label: string, invalid: boolean): Record<string, unknown> {
  const criteria = question.criteria;
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw new Error('Choice question criteria required');
  const options = Object.keys(criteria as Record<string, unknown>);
  if (!options.length) throw new Error('Choice question criteria required');
  const choice = invalid ? '__fixture_invalid_choice__' : label;
  if (!invalid && !options.includes(choice)) throw new Error('Fixture label is not an option in the received rubric');
  return { type: 'choice', choice, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])) };
}

function validateProviderRequest(request: Record<string, unknown>): Record<string, unknown> {
  const state = request.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Fixture requires model state');
  const item = (state as Record<string, unknown>).item;
  if (!item || typeof item !== 'object' || Array.isArray(item) || 'id' in item) throw new Error('Fixture model state must omit item identity');
  const updates = (state as Record<string, unknown>).updates;
  if (!Array.isArray(updates) || updates.some(update => !update || typeof update !== 'object' || Array.isArray(update) || 'id' in update)) throw new Error('Fixture model state must omit update identity');
  const questions = request.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) throw new Error('Choice questions required');
  const questionRecord = questions as Record<string, unknown>;
  const expected = Object.keys(ASSESSMENT_QUESTIONS).sort();
  const actual = Object.keys(questionRecord).sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) throw new Error('Fixture only accepts the decision assessment question');
  const question = questionRecord.decision;
  if (!question || typeof question !== 'object' || Array.isArray(question) || (question as Record<string, unknown>).type !== 'choice') throw new Error('Fixture only accepts a choice question');
  const criteria = (question as Record<string, unknown>).criteria;
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw new Error('Fixture requires choice criteria');
  return request;
}

export async function startSystemOneFixture({ port, apiKey }: { port: number; apiKey: string }): Promise<SystemOneFixture> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('port must be an integer between 0 and 65535');
  if (!apiKey || apiKey.trim() !== apiKey) throw new Error('apiKey must be a non-empty untrimmed value');
  let mode: FixtureMode = 'valid';
  let labelsByItemTitle: Record<string, AssessmentLabels> = {};
  const captured: CapturedRequest[] = [];
  const requestWaiters: Array<{ count: number; resolve: (value: CapturedRequest[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  const held: Held[] = [];
  const server: Server = createServer(async (request, response) => {
    if (!bearerAuthorized(request, apiKey)) { json(response, { error: 'unauthorized' }, 401); return; }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/__fixture/requests') { json(response, captured); return; }
      if (request.method === 'POST' && url.pathname === '/__fixture/release') {
        const body = recordObject(await readBody(request));
        if (Object.keys(body).length !== 0) throw Object.assign(new Error('Release body must be empty'), { statusCode: 400 });
        while (held.length) {
          const pending = held.shift()!;
          json(pending.response, makeResponse(pending.request, labelsByItemTitle, false));
        }
        json(response, { released: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/__fixture/control') {
        const body = recordObject(await readBody(request));
        if (typeof body.mode !== 'string' || !Object.prototype.hasOwnProperty.call(VALID_MODES, body.mode)) throw Object.assign(new Error('Invalid fixture mode'), { statusCode: 400 });
        mode = body.mode as FixtureMode;
        if (body.labelsByItemTitle !== undefined) labelsByItemTitle = recordObject(body.labelsByItemTitle) as Record<string, AssessmentLabels>;
        json(response, { mode });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/systemone') {
        const parsed = validateProviderRequest(recordObject(await readBody(request)));
        const heldRequest = mode === 'hold';
        captured.push({ request: structuredClone(parsed), held: heldRequest });
        for (const waiter of requestWaiters.splice(0)) {
          if (captured.length >= waiter.count) { clearTimeout(waiter.timer); waiter.resolve(captured); } else requestWaiters.push(waiter);
        }
        if (mode === 'http_error') { json(response, { error: 'fixture provider failure' }, 503); return; }
        if (mode === 'malformed') { response.statusCode = 200; response.setHeader('content-type', 'text/plain'); response.end('not json'); return; }
        if (heldRequest) { held.push({ response, request: parsed }); return; }
        json(response, makeResponse(parsed, labelsByItemTitle, mode === 'invalid_choice'));
        return;
      }
      json(response, { error: 'not found' }, 404);
    } catch (error) {
      const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 400;
      json(response, { error: error instanceof Error ? error.message : 'fixture request failed' }, status);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    control: async value => { const result = await fetch(`${origin}/__fixture/control`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(value) }); if (!result.ok) throw new Error(`Fixture control failed: ${result.status}`); },
    requests: async () => { const result = await fetch(`${origin}/__fixture/requests`, { headers: { authorization: `Bearer ${apiKey}` } }); if (!result.ok) throw new Error(`Fixture request read failed: ${result.status}`); return await result.json() as CapturedRequest[]; },
    waitForRequests: count => {
      if (captured.length >= count) return Promise.resolve(captured);
      return new Promise<CapturedRequest[]>((resolve, reject) => {
        const waiter = { count, resolve, reject, timer: setTimeout(() => { const index = requestWaiters.indexOf(waiter); if (index >= 0) requestWaiters.splice(index, 1); reject(new Error(`Timed out waiting for ${count} fixture requests`)); }, 15_000) };
        requestWaiters.push(waiter);
      });
    },
    release: async () => { const result = await fetch(`${origin}/__fixture/release`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: '{}' }); if (!result.ok) throw new Error(`Fixture release failed: ${result.status}`); },
    close: async () => { for (const pending of held.splice(0)) pending.response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

function makeResponse(request: Record<string, unknown>, labelsByItemTitle: Record<string, AssessmentLabels>, invalid: boolean): Record<string, unknown> {
  const questions = request.questions as Record<string, Record<string, unknown>>;
  const labels = labelsByItemTitle[itemTitleFromRequest(request) ?? ''] ?? { decision: 'unclear' };
  return { model: 'openjev-fixture', answers: { decision: answerFor(questions.decision, labels.decision, invalid) } };
}

function readPrivateKey(path: string): string {
  const mode = statSync(path).mode;
  if ((mode & 0o077) !== 0) throw new Error('key file must be private');
  const key = readFileSync(path, 'utf8');
  if (!key || key.trim() !== key) throw new Error('key file must contain a non-empty untrimmed key');
  return key;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--port' || args[2] !== '--key-file' || !/^\d+$/.test(args[1])) throw new Error('Usage: --port <integer> --key-file <path>');
  const port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error('port must be an integer between 0 and 65535');
  const fixture = await startSystemOneFixture({ port, apiKey: readPrivateKey(args[3]) });
  console.log(fixture.origin);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
