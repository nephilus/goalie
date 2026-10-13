import { useCallback, useEffect, useRef, useState } from 'react';

export class AdrRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function adrRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new AdrRequestError(body?.error ?? `Request failed (${response.status}). Please try again.`, response.status);
  return body.data as T;
}

/** Cancels obsolete reads when filters, pages, or the shared revision change. */
export function useAdrResource<T>(path: string | null, refreshKey: number = 0) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const reload = useCallback(() => setRetry(value => value + 1), []);
  useEffect(() => {
    const current = ++sequence.current;
    setData(null);
    setError('');
    if (!path) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    adrRequest<T>(path, { signal: controller.signal }).then(value => {
      if (current === sequence.current) setData(value);
    }).catch(reason => {
      if (!controller.signal.aborted && current === sequence.current) setError(reason instanceof Error ? reason.message : 'Could not load this view.');
    }).finally(() => {
      if (current === sequence.current && !controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, refreshKey, retry]);
  return { data, loading, error, reload };
}
