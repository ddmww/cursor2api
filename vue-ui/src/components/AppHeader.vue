<template>
  <header class="app-header">
    <div class="header-left">
      <h1><span class="ic">⚡</span> Cursor2API 日志</h1>
    </div>
    <div class="header-center">
      <div class="stats-pills">
        <div class="sc"><b>{{ stats.totalRequests }}</b> 请求</div>
        <div class="sc sc-ok">✓<b>{{ stats.successCount }}</b></div>
        <div class="sc sc-err">✗<b>{{ stats.errorCount }}</b></div>
        <div class="sc" v-if="stats.avgResponseTime"><b>{{ fmtMs(stats.avgResponseTime) }}</b> 均耗</div>
        <div class="sc" v-if="stats.avgTTFT">⚡<b>{{ fmtMs(stats.avgTTFT) }}</b> TTFT</div>
      </div>
    </div>
    <div class="header-right">
      <button v-if="loggedIn && authStore.token" class="hdr-btn logout-btn" @click="onLogout">退出</button>
      <button class="hdr-btn clear-btn" @click="onClear">🗑 清空</button>
      <button class="hdr-btn theme-btn" @click="toggleTheme">{{ isDark ? '☀️' : '🌙' }}</button>
      <div class="conn" :class="connected ? 'on' : 'off'">
        <div class="d" />
        <span>{{ connected ? '已连接' : '重连中…' }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useStatsStore } from '../stores/stats';
import { useLogsStore } from '../stores/logs';
import { useAuthStore } from '../stores/auth';
import { storeToRefs } from 'pinia';

defineProps<{ connected: boolean }>();

const statsStore = useStatsStore();
const logsStore = useLogsStore();
const authStore = useAuthStore();
const { stats } = storeToRefs(statsStore);
const { loggedIn } = storeToRefs(authStore);

function fmtMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(2).replace(/\.?0+$/, '') + 's' : ms + 'ms';
}

async function onLogout() {
  authStore.clearToken();
  // 检查无 token 时是否还能访问（open access 模式），能则不跳转登录页
  try {
    const res = await fetch('/api/stats');
    if (res.ok) {
      // 服务端不需要授权，保持登录状态
      return;
    }
  } catch { /* ignore */ }
  authStore.loggedIn = false;
}

const isDark = ref(false);

onMounted(() => {
  isDark.value = (localStorage.getItem('cursor2api_theme') ?? 'light') === 'dark';
  applyTheme();
});

function applyTheme() {
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
}

function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem('cursor2api_theme', isDark.value ? 'dark' : 'light');
  applyTheme();
}

async function onClear() {
  if (!confirm('确定清空所有日志？此操作不可恢复。')) return;
  await logsStore.clear();
  await statsStore.load();
}
</script>

<style scoped>
.app-header {
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 14px 20px;
  background:
    radial-gradient(ellipse 60% 100% at 50% -20%, rgba(88,166,255,0.10) 0%, transparent 70%),
    rgba(13,17,23,.95);
  backdrop-filter: blur(24px) saturate(180%);
  border-bottom: 1px solid rgba(99,102,241,0.15);
  flex-shrink: 0; z-index: 10; position: relative;
}
[data-theme="light"] .app-header {
  background:
    radial-gradient(ellipse 60% 100% at 50% -20%, rgba(99,102,241,0.05) 0%, transparent 70%),
    rgba(255,255,255,.92);
  border-bottom: 1px solid rgba(226,232,240,.9);
  box-shadow: 0 1px 6px rgba(0,0,0,.06);
}
[data-theme="light"] .sc {
  background: #fff;
  border-color: #e2e8f0;
  box-shadow: 0 1px 3px rgba(0,0,0,.05);
}
.header-left { display: flex; align-items: center; gap: 14px; }
.header-center { display: flex; justify-content: center; align-items: center; }
h1 {
  font-size: 16px; font-weight: 700;
  background: linear-gradient(135deg, #6366f1, #3b82f6, #0891b2);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  display: flex; align-items: center; gap: 6px;
}
h1 .ic { font-size: 17px; -webkit-text-fill-color: initial; }
.stats-pills { display: flex; gap: 6px; align-items: center; }
.sc {
  padding: 4px 12px; background: var(--bg2); border: 1px solid var(--border);
  border-radius: 20px; font-size: 11px; color: var(--text-muted);
  display: flex; align-items: center; gap: 4px;
  box-shadow: var(--shadow-sm);
}
.sc b { font-family: var(--mono); color: var(--text); font-weight: 600; margin: 0 1px; }
.sc-ok { color: var(--green); }
.sc-ok b { color: var(--green); }
.sc-err { color: var(--red); }
.sc-err b { color: var(--red); }
.header-right { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.hdr-btn {
  padding: 5px 12px; font-size: 11px; font-weight: 500;
  background: var(--bg1); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-muted);
  cursor: pointer; transition: all .2s; box-shadow: var(--shadow-sm);
}
.hdr-btn:hover { border-color: var(--text-muted); color: var(--text); }
.clear-btn:hover { border-color: var(--red); color: var(--red); }
.theme-btn:hover { border-color: var(--accent); color: var(--accent); }
.logout-btn:hover { border-color: var(--orange); color: var(--orange); }
.conn {
  display: flex; align-items: center; gap: 5px;
  font-size: 10px; font-weight: 500;
  padding: 4px 10px; border-radius: 20px;
  border: 1px solid var(--border); background: var(--bg1);
}
.conn.on { color: var(--green); border-color: color-mix(in srgb, var(--green) 30%, transparent); }
.conn.off { color: var(--red); border-color: color-mix(in srgb, var(--red) 30%, transparent); }
.conn .d { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.conn.on .d { background: var(--green); animation: pulse 2s infinite; }
.conn.off .d { background: var(--red); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
</style>
