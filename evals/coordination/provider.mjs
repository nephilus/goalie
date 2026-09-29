import { appendFile } from 'node:fs/promises';

let requests = 0;
const advisorResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'coordination_advice',
    strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: {
        answer: {
          type: 'object', additionalProperties: false, required: ['text', 'evidence'],
          properties: {
            text: { type: 'string', minLength: 1 },
            evidence: {
              type: 'array', minItems: 1,
              items: {
                type: 'object', additionalProperties: false, required: ['sourceId', 'quote'],
                properties: { sourceId: { type: 'string', minLength: 1 }, quote: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
      },
    },
  },
};

// A small adapter makes every physical request visible: no caching or retries.
export default class GatewayProvider {
  id() { return `goalie:${process.env.GOALIE_EVAL_MODEL || 'unconfigured'}`; }

  async callApi(prompt, context) {
    const base = process.env.GOALIE_EVAL_BASE_URL;
    const key = process.env.GOALIE_EVAL_API_KEY;
    const model = process.env.GOALIE_EVAL_MODEL;
    const journal = process.env.GOALIE_EVAL_JOURNAL;
    const maxTokens = Number(process.env.GOALIE_EVAL_MAX_TOKENS || 4096);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384) throw new Error('Evaluation token budget must be an integer between 1 and 16384');
    const thinking = process.env.GOALIE_EVAL_THINKING || 'default';
    if (!['default', 'off'].includes(thinking)) throw new Error('Evaluation thinking mode must be default or off');
    const thinkingBudget = process.env.GOALIE_EVAL_THINKING_BUDGET === undefined ? null : Number(process.env.GOALIE_EVAL_THINKING_BUDGET);
    if (thinkingBudget !== null && (!Number.isInteger(thinkingBudget) || thinkingBudget < 0 || thinkingBudget >= maxTokens || thinking === 'off')) throw new Error('Thinking budget must leave output room and cannot be combined with thinking off');
    if (!base || !key || !model || !journal) throw new Error('Explicit gateway, model, credential, and private journal are required');
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid gateway base URL');
    if (++requests > Number(process.env.GOALIE_EVAL_MAX_REQUESTS || 144)) throw new Error('Evaluation request ceiling reached');
    const messages = JSON.parse(prompt);
    if (!Array.isArray(messages) || messages.some(m => !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Prompt must render valid chat messages');
    const responseFormat = context.vars.answerOnly === true ? advisorResponseFormat : { type: 'json_object' };
    const start = Date.now();
    const record = { request: requests, caseId: context.vars.caseId, promptLabel: context.prompt?.label?.split(':', 1)[0], model, maxTokens, thinking, thinkingBudget, responseFormat: responseFormat.type, startedAt: new Date(start).toISOString() };
    let result;
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages, temperature: 0.2, max_tokens: maxTokens, response_format: responseFormat,
          ...(thinking === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
          ...(thinkingBudget === null ? {} : { thinking_token_budget: thinkingBudget }),
        }),
      });
      record.httpStatus = response.status;
      if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
      const body = await response.json();
      const choice = body.choices?.[0];
      record.responseModel = body.model;
      record.finishReason = choice?.finish_reason;
      record.usage = body.usage;
      record.output = choice?.message?.content;
      if (typeof record.output !== 'string') throw new Error('Gateway returned no textual answer');
      result = {
        output: record.output, cached: false,
        tokenUsage: { total: body.usage?.total_tokens, prompt: body.usage?.prompt_tokens, completion: body.usage?.completion_tokens, numRequests: 1 },
        metadata: { model: body.model, finishReason: choice.finish_reason, reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens, request: requests },
      };
      if (choice.finish_reason !== 'stop') result.error = `Incomplete generation: ${choice.finish_reason}`;
    } catch (error) {
      // Never persist headers or an upstream error body that could echo credentials.
      const message = error instanceof Error && /^(Gateway HTTP|Gateway returned|Prompt must)/.test(error.message) ? error.message : `Inference transport failure (${error.name || 'Error'})`;
      record.error = message;
      result = { error: message, cached: false };
    }
    record.latencyMs = Date.now() - start;
    await appendFile(journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return result;
  }
}
