// Thin fetch wrapper. Pulls JWT from localStorage and adds the Bearer header.
// Returns parsed JSON or throws { status, error } on non-2xx.

const TOKEN_KEY = 'fin_token';

export type ApiError = { status: number; error: string };

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('fin_user');
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });

  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const err: ApiError = { status: res.status, error: (data && data.error) || res.statusText };
    if (res.status === 401) clearToken();
    throw err;
  }
  return data as T;
}

export const api = {
  get:  <T = any>(url: string)               => request<T>('GET', url),
  post: <T = any>(url: string, body?: any)   => request<T>('POST', url, body),
  put:  <T = any>(url: string, body?: any)   => request<T>('PUT', url, body),
  del:  <T = any>(url: string)               => request<T>('DELETE', url)
};
