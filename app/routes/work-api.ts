import { z } from 'zod';
import { requireAuth, requireCsrf, AuthError } from '../server/auth.server';
import { getConfig } from '../server/config.server';
import { readWork, executeWork, WorkError } from '../server/work.server';
import { AssistError, assistStatus, suggestWorkFields, suggestWorkstreamGoals } from '../server/work-assist.server';
import { readWorkAssessments, assessWorkItem, setWorkAssessmentsEnabled, setWorkAssessmentScope } from '../server/work-assessment.server';
import { assistRequestSchema, workstreamAssistRequestSchema } from '../shared/work-assist';
import { assessmentRunRequestSchema, assessmentScopeRequestSchema } from '../shared/work-assessment';
import { commandRequestSchema } from '../shared/work';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}) => Response.json(data, { status, headers: { ...headers, ...extraHeaders } });
function assessmentItemId(url: URL): string | undefined {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'itemId')) throw new WorkError('Unsupported assessment query parameter.', 422, 'invalid_request');
  const values = url.searchParams.getAll('itemId');
  if (values.length > 1 || values[0] !== undefined && !assessmentRunRequestSchema.shape.itemId.safeParse(values[0]).success) throw new WorkError('Invalid assessment item ID.', 422, 'invalid_request');
  return values[0];
}
function failure(error: unknown): Response {
  if (error instanceof z.ZodError) return json({ error: 'Check the submitted fields.', code: 'invalid_request', fields: error.issues.map(issue => ({ path: issue.path, message: issue.message })) }, 422);
  if (error instanceof AuthError || error instanceof WorkError || error instanceof AssistError) {
    return json({ error: error.message, code: error.code }, error.status ?? 500, error instanceof WorkError && error.code === 'assessment_busy' ? { 'Retry-After': '2' } : {});
  }
  console.error('goalie.work.failure', error instanceof Error ? error.name : 'UnknownError');
  return json({ error: 'The request failed. Try again; your changes have not been confirmed.', code: 'internal_error' }, 500);
}
async function body(request: Request): Promise<unknown> {
  const limit = getConfig().maxBodyBytes;
  if (Number(request.headers.get('content-length')) > limit) throw new WorkError('Request is too large.', 413, 'too_large');
  if (!request.body) throw new WorkError('A request body is required.', 422, 'invalid_request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new WorkError('Request is too large.', 413, 'too_large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw new WorkError('Request must be valid JSON.', 422, 'invalid_request'); }
}
export async function loader({ request }: { request: Request }): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname !== '/api/work' && url.pathname !== '/api/work/assessments') return json({ error: 'Not found.', code: 'not_found' }, 404);
    const auth = await requireAuth(request);
    if (url.pathname === '/api/work/assessments') {
      const data = await readWorkAssessments(auth.person, assessmentItemId(url));
      return json({ data, user: auth.person, csrfToken: auth.csrfToken });
    }
    return json({ data: await readWork(auth.person), user: auth.person, csrfToken: auth.csrfToken, assist: assistStatus() });
  } catch (error) { return failure(error); }
}
export async function action({ request }: { request: Request }): Promise<Response> {
  try {
    if (request.method !== 'POST') return json({ error: 'Use POST.', code: 'method_not_allowed' }, 405);
    const auth = await requireAuth(request);
    await requireCsrf(request, auth);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/work/assessments/scope') {
      const requestScope = assessmentScopeRequestSchema.parse(await body(request));
      return json({ data: await setWorkAssessmentScope(auth.person, requestScope.scope) });
    }
    if (pathname === '/api/work/assessments/preference') {
      const preference = z.object({ enabled: z.boolean() }).strict().parse(await body(request));
      return json({ data: await setWorkAssessmentsEnabled(auth.person, preference.enabled) });
    }
    if (pathname === '/api/work/assessments') {
      const assessment = assessmentRunRequestSchema.parse(await body(request));
      return json({ data: await assessWorkItem(auth.person, assessment) });
    }
    if (pathname === '/api/work/assist') {
      const assistRequest = assistRequestSchema.parse(await body(request));
      return json(await suggestWorkFields(assistRequest, auth.person));
    }
    if (pathname === '/api/work/assist/workstream') {
      const assistRequest = workstreamAssistRequestSchema.parse(await body(request));
      return json(await suggestWorkstreamGoals(assistRequest, auth.person));
    }
    if (pathname !== '/api/work') return json({ error: 'Not found.', code: 'not_found' }, 404);
    const data = await executeWork(commandRequestSchema.parse(await body(request)), auth.person);
    return json({ data, user: auth.person, csrfToken: auth.csrfToken, assist: assistStatus() });
  } catch (error) { return failure(error); }
}
