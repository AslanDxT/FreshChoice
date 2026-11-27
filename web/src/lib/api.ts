/**
 * API client. The CSRF token lives only in memory (never in storage). A request that fails to
 * reach the server is reported as NETWORK so the UI never claims an unsaved change was saved.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

let csrfToken = '';
export function setCsrfToken(t: string) {
  csrfToken = t;
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
export function onAuthError(fn: Listener) {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
}

async function request<T>(method: string, url: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'You appear to be offline, or the server cannot be reached. Nothing was saved.');
  }
  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status}).`, data?.error?.details);
    if (res.status === 401 || err.code === 'PASSWORD_CHANGE_REQUIRED' || err.code === 'CSRF') authListeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  upload: <T = any>(url: string, form: FormData) => request<T>('PUT', url, form, true),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
