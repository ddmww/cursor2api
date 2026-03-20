import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { LogEntry, RequestSummary, Payload } from '../types';
import { fetchRequests, fetchLogs, fetchPayload, clearLogs } from '../api';

export const useLogsStore = defineStore('logs', () => {
  const reqs = ref<RequestSummary[]>([]);
  const curLogs = ref<LogEntry[]>([]);      // 当前选中请求的日志
  const globalLogs = ref<LogEntry[]>([]);   // 全局实时日志流（未选中时显示）
  const curRequestId = ref<string | null>(null);
  const payload = ref<Payload | null>(null);
  const search = ref('');
  const statusFilter = ref<'all' | 'success' | 'error' | 'processing' | 'intercepted'>('all');
  const timeFilter = ref<'all' | 'today' | '2d' | '7d' | '30d'>('all');

  function getTimeCutoff(): number {
    if (timeFilter.value === 'all') return 0;
    const now = Date.now();
    if (timeFilter.value === 'today') {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    const map: Record<string, number> = { '2d': 2, '7d': 7, '30d': 30 };
    return now - (map[timeFilter.value] ?? 0) * 86400000;
  }

  const filteredReqs = computed(() => {
    let list = reqs.value;
    if (search.value) {
      const q = search.value.toLowerCase();
      list = list.filter(r =>
        r.requestId.toLowerCase().includes(q) ||
        r.model.toLowerCase().includes(q) ||
        (r.title ?? '').toLowerCase().includes(q) ||
        (r.error ?? '').toLowerCase().includes(q)
      );
    }
    if (statusFilter.value !== 'all') {
      list = list.filter(r => r.status === statusFilter.value);
    }
    const cutoff = getTimeCutoff();
    if (cutoff > 0) list = list.filter(r => r.startTime >= cutoff);
    return list;
  });

  // 当前显示的日志：选中请求时显示该请求日志，否则显示全局流最后 200 条
  const displayLogs = computed(() =>
    curRequestId.value ? curLogs.value : globalLogs.value.slice(-200)
  );

  async function loadRequests() {
    try { reqs.value = await fetchRequests(100); } catch { /* ignore */ }
    // 加载历史全局日志（最近 200 条），填充实时流初始内容
    try {
      const logs = await fetchLogs();
      globalLogs.value = logs.slice(-200);
    } catch { /* ignore */ }
  }

  async function selectRequest(id: string) {
    curRequestId.value = id;
    // 保留旧 curLogs/payload 直到新数据就绪，避免中间空态闪烁
    try {
      const [l, p] = await Promise.all([fetchLogs({ requestId: id }), fetchPayload(id)]);
      if (curRequestId.value === id) {
        curLogs.value = l;
        payload.value = p;
      }
    } catch {
      if (curRequestId.value === id) {
        curLogs.value = [];
        payload.value = null;
      }
    }
  }

  function deselect() {
    curRequestId.value = null;
    curLogs.value = [];
    payload.value = null;
  }

  function addLog(entry: LogEntry) {
    // 全局流
    globalLogs.value.push(entry);
    if (globalLogs.value.length > 2000) globalLogs.value = globalLogs.value.slice(-1500);
    // 当前请求流
    if (entry.requestId === curRequestId.value) {
      curLogs.value.push(entry);
    }
  }

  function upsertRequest(summary: RequestSummary) {
    const idx = reqs.value.findIndex(r => r.requestId === summary.requestId);
    if (idx >= 0) {
      reqs.value[idx] = summary;
    } else {
      reqs.value.unshift(summary);
    }
  }

  async function clear() {
    await clearLogs();
    reqs.value = [];
    curLogs.value = [];
    globalLogs.value = [];
    curRequestId.value = null;
    payload.value = null;
  }

  // 仅清空前端状态，不调用后端 API（退出登录时使用）
  function resetState() {
    reqs.value = [];
    curLogs.value = [];
    globalLogs.value = [];
    curRequestId.value = null;
    payload.value = null;
  }

  return {
    reqs, curLogs, globalLogs, displayLogs, curRequestId, payload,
    search, statusFilter, timeFilter, filteredReqs,
    loadRequests, selectRequest, deselect, addLog, upsertRequest, clear, resetState,
  };
});
