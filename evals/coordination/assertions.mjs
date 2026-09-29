const OUTPUT_KEYS = ['suggestions', 'questions'];
const ANSWER_OUTPUT_KEYS = ['answer', ...OUTPUT_KEYS];
const ANSWER_ONLY_KEYS = ['answer'];
const ANSWER_KEYS = ['text', 'evidence'];
const SUGGESTION_KEYS = ['workstreamIds', 'summary', 'reasoning', 'evidence', 'nextStep'];
const QUESTION_KEYS = ['workstreamIds', 'question', 'whyItMatters', 'evidence'];
const CONCISE_SUGGESTION_KEYS = ['workstreamIds', 'evidence', 'nextStep'];
const CONCISE_QUESTION_KEYS = ['workstreamIds', 'question', 'evidence'];
const EVIDENCE_KEYS = ['sourceId', 'quote'];
const MAX_TEXT = 4_000;
const MAX_ID = 200;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, expected) => isObject(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const nonemptyString = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;
const boundedId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID;
const sourceText = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => new Set(values).size === values.length;

const fail = reason => ({ pass: false, score: 0, reason });
const pass = reason => ({ pass: true, score: 1, reason });

function varsOf(context) {
  return isObject(context?.vars) ? context.vars : (isObject(context) ? context : {});
}

function contextIndex(context) {
  const vars = varsOf(context);
  const input = vars.input;
  if (!isObject(input) || !Array.isArray(input.workstreams) || !Array.isArray(input.sources)) {
    return { error: 'context.vars.input must contain workstreams and sources arrays' };
  }

  const workstreamIds = input.workstreams.map(workstream => workstream?.id);
  if (input.workstreams.some(workstream => !isObject(workstream) || !boundedId(workstream.id)) || !unique(workstreamIds)) {
    return { error: 'input workstreams must have unique nonempty IDs' };
  }
  const knownWorkstreams = new Set(workstreamIds);
  const sources = new Map();
  for (const source of input.sources) {
    const scopes = vars.extendedEvidence && Array.isArray(source?.workstreamIds) ? source.workstreamIds : [source?.workstreamId];
    if (!isObject(source) || !boundedId(source.id) || !scopes.length || !unique(scopes) || scopes.some(id => !knownWorkstreams.has(id)) || !sourceText(source.text) || sources.has(source.id)) {
      return { error: 'input sources must have unique IDs, known workstreams, and nonempty text' };
    }
    sources.set(source.id, source);
  }
  return { vars, input, knownWorkstreams, sources };
}

function parseOutput(output) {
  if (typeof output !== 'string' || output.trim() === '') return { error: 'output must be a strict JSON string' };
  try {
    return { value: JSON.parse(output) };
  } catch {
    return { error: 'output must be parseable as strict JSON with no surrounding prose' };
  }
}

function checkIds(ids, knownWorkstreams, label, minimum) {
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > knownWorkstreams.size || ids.some(id => !boundedId(id)) || !unique(ids)) {
    return `${label}.workstreamIds must contain unique known IDs (minimum ${minimum})`;
  }
  if (ids.some(id => !knownWorkstreams.has(id))) return `${label}.workstreamIds contains an unknown workstream ID`;
  return null;
}

// Contextual evidence can explain why its owning workstream is excluded from an action.
function checkEvidence(evidence, sources, label) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > sources.size) {
    return `${label}.evidence must contain one to ${sources.size} citation(s)`;
  }
  const seen = new Set();
  for (let index = 0; index < evidence.length; index += 1) {
    const citation = evidence[index];
    const citationLabel = `${label}.evidence[${index}]`;
    if (!keysAre(citation, EVIDENCE_KEYS) || !boundedId(citation.sourceId) || !nonemptyString(citation.quote)) {
      return `${citationLabel} must contain only sourceId and a nonempty quote`;
    }
    if (seen.has(citation.sourceId)) return `${citationLabel} repeats source ${citation.sourceId}`;
    seen.add(citation.sourceId);
    const source = sources.get(citation.sourceId);
    if (!source) return `${citationLabel} cites unknown source ${citation.sourceId}`;
    if (!source.text.includes(citation.quote)) {
      return `${citationLabel} quote is not an exact substring of source ${citation.sourceId}; copy it verbatim`;
    }
  }
  return null;
}

function checkGeneratedText(value, label) {
  if (!nonemptyString(value)) return `${label} must be a nonempty string of at most ${MAX_TEXT} characters`;
  return null;
}

function checkOutput(value, index) {
  const { knownWorkstreams, sources } = index;
  const requireAnswer = index.vars.requireAnswer === true;
  const conciseAdvice = index.vars.conciseAdvice === true;
  const answerOnly = index.vars.answerOnly === true;
  if (answerOnly && (!requireAnswer || conciseAdvice || index.vars.allowNullNextStep === true)) return 'answer-only advice cannot use action-contract options';
  if (conciseAdvice && !requireAnswer) return 'concise advice requires an evidence-backed answer';
  const outputKeys = answerOnly ? ANSWER_ONLY_KEYS : requireAnswer ? ANSWER_OUTPUT_KEYS : OUTPUT_KEYS;
  if (!keysAre(value, outputKeys)) return `output must contain exactly ${outputKeys.join(', ')}`;
  if (requireAnswer) {
    if (!keysAre(value.answer, ANSWER_KEYS)) return 'answer must contain exactly text and evidence';
    const answerError = checkGeneratedText(value.answer.text, 'answer.text') || checkEvidence(value.answer.evidence, sources, 'answer');
    if (answerError) return answerError;
  }
  if (answerOnly) return null;
  if (!Array.isArray(value.suggestions) || value.suggestions.length > 3) return 'suggestions must be an array with at most 3 entries';
  if (!Array.isArray(value.questions) || value.questions.length > 2) return 'questions must be an array with at most 2 entries';

  for (let position = 0; position < value.suggestions.length; position += 1) {
    const suggestion = value.suggestions[position];
    const label = `suggestions[${position}]`;
    if (!keysAre(suggestion, conciseAdvice ? CONCISE_SUGGESTION_KEYS : SUGGESTION_KEYS)) return `${label} has extra or missing keys`;
    const idsError = checkIds(suggestion.workstreamIds, knownWorkstreams, label, 2);
    if (idsError) return idsError;
    for (const field of conciseAdvice ? ['nextStep'] : ['summary', 'reasoning', 'nextStep']) {
      if (field === 'nextStep' && index.vars.allowNullNextStep === true && suggestion[field] === null) continue;
      const textError = checkGeneratedText(suggestion[field], `${label}.${field}`);
      if (textError) return textError;
    }
    const evidenceError = checkEvidence(suggestion.evidence, sources, label);
    if (evidenceError) return evidenceError;
  }

  for (let position = 0; position < value.questions.length; position += 1) {
    const question = value.questions[position];
    const label = `questions[${position}]`;
    if (!keysAre(question, conciseAdvice ? CONCISE_QUESTION_KEYS : QUESTION_KEYS)) return `${label} has extra or missing keys`;
    const idsError = checkIds(question.workstreamIds, knownWorkstreams, label, 1);
    if (idsError) return idsError;
    for (const field of conciseAdvice ? ['question'] : ['question', 'whyItMatters']) {
      const textError = checkGeneratedText(question[field], `${label}.${field}`);
      if (textError) return textError;
    }
    const evidenceError = checkEvidence(question.evidence, sources, label);
    if (evidenceError) return evidenceError;
  }
  return null;
}

function readValidOutput(output, context) {
  const parsed = parseOutput(output);
  if (parsed.error) return parsed;
  const index = contextIndex(context);
  if (index.error) return index;
  const outputError = checkOutput(parsed.value, index);
  if (outputError) return { error: outputError };
  return { value: parsed.value, index };
}

export function integrity(output, context) {
  const checked = readValidOutput(output, context);
  if (checked.error) return fail(`integrity: ${checked.error}`);
  return pass('integrity: strict output shape, bounds, known IDs, and exact source quotes are valid; semantic support remains for review');
}

