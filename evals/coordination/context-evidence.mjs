// Conversation scope is context scope, not proof that every workstream is affected.
export function withContextEvidence(input) {
  const sourceIndex = new Map(input.sources.map(source => [source.id, source]));
  const allWorkstreams = input.workstreams.map(workstream => workstream.id);
  const extra = input.priorDecisions.map(decision => {
    const scopes = decision.sourceIds.flatMap(id => {
      const source = sourceIndex.get(id);
      if (!source) throw new Error(`Decision ${decision.id} references unknown source ${id}`);
      return [source.workstreamId];
    });
    return { id: decision.id, kind: 'prior-decision', workstreamIds: scopes.length ? [...new Set(scopes)] : allWorkstreams, text: decision.text };
  });
  input.conversation.forEach((turn, index) => {
    if (turn.role === 'user') extra.push({ id: `conversation:${index + 1}`, kind: 'user-clarification', workstreamIds: allWorkstreams, text: turn.content });
  });
  const sources = [...input.sources, ...extra];
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('Context evidence ID collision');
  return { ...input, sources };
}
