import type { LogEntry, RequestSummary, Stats, Payload } from './types';
import { useAuthStore } from './stores/auth';
import { getActivePinia } from 'pinia';

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem('cursor2api_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: getAuthHeader() });
  if (res.status === 401) {
    const pinia = getActivePinia();
    if (pinia) useAuthStore(pinia).logout();
    throw new Error('HTTP 401');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchLogs(params?: { requestId?: string; since?: number }): Promise<LogEntry[]> {
  const q = new URLSearchParams();
  if (params?.requestId) q.set('requestId', params.requestId);
  if (params?.since != null) q.set('since', String(params.since));
  const qs = q.toString() ? '?' + q.toString() : '';
  return apiFetch<LogEntry[]>(`/api/logs${qs}`);
}

export function fetchRequests(limit = 50): Promise<RequestSummary[]> {
  return apiFetch<RequestSummary[]>(`/api/requests?limit=${limit}`);
}

export function fetchStats(): Promise<Stats> {
  return apiFetch<Stats>('/api/stats');
}

export function fetchPayload(requestId: string): Promise<Payload> {
  return apiFetch<Payload>(`/api/payload/${requestId}`);
}

export async function clearLogs(): Promise<void> {
  const res = await fetch('/api/logs/clear', {
    method: 'POST',
    headers: getAuthHeader(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function createSSEConnection(onMessage: (event: string, data: unknown) => void): EventSource {
  const token = localStorage.getItem('cursor2api_token');
  const url = token ? `/api/logs/stream?token=${encodeURIComponent(token)}` : '/api/logs/stream';
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try { onMessage('message', JSON.parse(e.data)); } catch { /* ignore */ }
  };
  const events = ['log', 'summary', 'stats'];
  for (const ev of events) {
    es.addEventListener(ev, (e) => {
      try { onMessage(ev, JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ }
    });
  }
  return es;
}
