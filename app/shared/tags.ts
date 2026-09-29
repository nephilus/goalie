export const MAX_TAGS_PER_ITEM = 20;
export const MAX_TAG_LENGTH = 40;

/** Normalize one manually supplied tag or throw when it cannot be stored. */
export function normalizeTag(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Tag must be a string');
  const normalized = value.normalize('NFKC');
  if (/[\p{Cc}\p{Cf}]/u.test(normalized)) throw new Error('Tags cannot contain control characters');
  const tag = normalized.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (!tag) throw new Error('Tags cannot be empty');
  if (tag.length > MAX_TAG_LENGTH) throw new Error(`Tags must be ${MAX_TAG_LENGTH} characters or fewer`);
  return tag;
}

export function collectTags(items: readonly { tags: readonly string[] }[]): string[] {
  return [...new Set(items.flatMap(item => item.tags))].sort();
}
