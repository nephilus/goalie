export type DefaultWorkView = 'all' | 'streams';

export function defaultWorkViewKey(accountId: string): string {
  return `goalie:work-default-view:${accountId}`;
}

export function parseDefaultWorkView(value: unknown): DefaultWorkView {
  return value === 'streams' ? 'streams' : 'all';
}

// Resolve storage inside the try block: even accessing localStorage can throw.
export function readDefaultWorkView(key: string, storage: () => Pick<Storage, 'getItem'>): DefaultWorkView {
  try { return parseDefaultWorkView(storage().getItem(key)); }
  catch { return 'all'; }
}

export function writeDefaultWorkView(key: string, value: DefaultWorkView, storage: () => Pick<Storage, 'setItem'>): void {
  try { storage().setItem(key, value); }
  catch { /* Keep the current tab's in-memory preference when storage is unavailable. */ }
}
