export type WorkLayout = 'standard' | 'compact';

export function workLayoutKey(accountId: string): string {
  return `goalie:work-layout:${accountId}`;
}

export function parseWorkLayout(value: unknown): WorkLayout {
  return value === 'compact' ? 'compact' : 'standard';
}

// Resolve storage inside the try block: even accessing localStorage can throw.
export function readWorkLayout(key: string, storage: () => Pick<Storage, 'getItem'>): WorkLayout {
  try { return parseWorkLayout(storage().getItem(key)); }
  catch { return 'standard'; }
}

export function writeWorkLayout(key: string, value: WorkLayout, storage: () => Pick<Storage, 'setItem'>): void {
  try { storage().setItem(key, value); }
  catch { /* Keep the current tab's in-memory preference when storage is unavailable. */ }
}
