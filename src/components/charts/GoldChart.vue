<script setup lang="ts">
// The chart draws; the bot decides. Candles and every overlay come from the bot's own
// /api/v1/gold/observations: MT5 candles plus the backend detectors' output
// (app/market/chart_observations.py). Lightweight Charts by TradingView is the renderer only -
// it receives observations, it never computes one.
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useBotStore } from '@/stores/ftbotwrapper';
import { useColorStore } from '@/stores/colors';
import { useSettingsStore } from '@/stores/settings';
import {
  CATEGORIES,
  DEFAULT_ENABLED,
  ZonesPrimitive,
  inView,
  toMarkers,
  toZones,
  uncategorised,
  zoneAt,
  type Observation,
  type Snapshot,
  type Zone,
} from './goldOverlays';
import {
  DrawingsPrimitive,
  TOOLS,
  loadDrawings,
  needsTwoPoints,
  saveDrawings,
  snap,
  storageKey,
  type Drawing,
  type Point,
  type Tool,
} from './goldDrawings';

interface TimeframeState {
  available: boolean;
  reason?: string;
  condition: string;
  close: number;
  structure: { state: string; direction: number; last_bos: string | null; bars_since_bos: number | null };
  trend: { direction: string };
  momentum: { roc_atr: number | null; state: string; change: string };
  volatility: { atr: number; atr_pct: number | null; regime: string; expanding: boolean };
  range: { high: number; low: number; position: number | null; width_atr: number | null; width_percentile: number | null };
  support_resistance: { resistance: number | null; support: number | null };
  liquidity: { recent_high: number | null; recent_low: number | null; equal_highs: number | null; equal_lows: number | null };
  data: { candles: number; last_closed: string; age_minutes: number; fresh: boolean; gaps: number };
}

interface DecisionState {
  decision: 'WAIT' | 'SETUP_READY' | 'REJECT';
  direction: string | null;
  candidate_strategy: string | null;
  conditions_met: string[];
  conditions_missing: string[];
  blocking_conditions: string[];
  reason_codes: string[];
  market_condition: string;
  valid_until: string | null;
  trading_enabled: boolean;
}

interface MarketState {
  engine_version: string;
  symbol: string;
  timestamp: string;
  session: string;
  price: number | null;
  market_state: Record<string, TimeframeState>;
  mtf_context: { directions: Record<string, string>; agreement: string; aligned: boolean };
  condition: string;
  condition_evidence: string[];
  warnings: string[];
  unknown: string[];
  data_quality: string;
  engine_status: string;
  decision: string;
  trading_enabled: boolean;
}

// The Gold routes sit behind auth_dependency (mount.py), so they are fetched through the bot
// store's named actions, which use FreqUI's authenticated client. The component never builds
// a request itself.
const REFRESH_MS = 15000;
// The engine's answer only moves when a candle closes, and the server caches it for 20s,
// so polling faster than that would just re-fetch an identical response.
const STATE_REFRESH_MS = 20000;
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
const TF_SECONDS: Record<string, number> = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const TF_LABEL: Record<string, string> = { '1d': 'D' };
const PRIMARY_TF = '1h';

const colorStore = useColorStore();
const settingsStore = useSettingsStore();
const botStore = useBotStore();

// WHICH BOT. The Gold routes are served by THIS freqtrade instance, so the token has to
// belong to a bot pointed at this same origin. BotLogin defaults the URL to
// window.location.origin, so the ordinary case matches exactly. Empty means same-origin too.
const sameOriginBot = computed<boolean>(() => {
  const url = botStore.selectedBotObj?.botUrl;
  if (!url) {
    return true;
  }
  return url.replace(/\/+$/, '') === window.location.origin.replace(/\/+$/, '');
});

/** Why a request could not even be attempted, or '' if it can. */
const blocked = computed<string>(() => {
  if (!botStore.hasBots) {
    return 'No bot is registered. Log in to a bot on this server to view the Gold chart.';
  }
  if (!botStore.selectedBot) {
    return 'No bot selected. Choose a bot on this server to view the Gold chart.';
  }
  if (!sameOriginBot.value) {
    return 'The selected bot points at a different server, so its login cannot authorise '
      + 'these routes. Select a bot running on this server.';
  }
  return '';
});

/** Turn a failed request into something a reader can act on. */
function describe(e: unknown): string {
  const status =
    (e as { status?: number })?.status ?? (e as { response?: { status?: number } })?.response?.status;
  if (status === 401 || status === 403) {
    return 'Not authorised (401). The bot session has expired - log in to it again.';
  }
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------------------- the chart

const snapshot = ref<Snapshot | null>(null);
const timeframe = ref('15m');
const enabled = ref<Record<string, boolean>>({ ...DEFAULT_ENABLED });
// Default view shows the backend's small, relevant selection; history shows every stored
// observation, including spent and hidden ones (CEO decision 2026-10-12).
const history = ref(false);

// ---- TradingView-style tools: the OWNER's drawings, kept in this browser only. They never
// reach the backend and never mix with the bot's observations (goldDrawings.ts).
const tool = ref<Tool>('cursor');
const magnet = ref(true);
const locked = ref(false);
const hideDrawings = ref(false);
const drawings = ref<Drawing[]>([]);
const undoStack = ref<Drawing[][]>([]);
let pending: Point | null = null;
const drawingsPrimitive = new DrawingsPrimitive();

// ---- favourites: categories pinned to the top bar, remembered per browser.
const FAV_KEY = 'gold-favourite-categories';
function readFavourites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return raw ? JSON.parse(raw) : ['structure', 'liquidity', 'fvg'];
  } catch {
    return ['structure', 'liquidity', 'fvg'];
  }
}
const favourites = ref<string[]>(readFavourites());
function toggleFavourite(cat: string) {
  favourites.value = favourites.value.includes(cat)
    ? favourites.value.filter((c) => c !== cat)
    : [...favourites.value, cat];
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favourites.value));
  } catch {
    /* favourites last for this page only */
  }
}
const indicatorsOpen = ref(false);
const prettyCat = (c: string) => c.replace(/_/g, ' ');
const selected = ref<Observation | null>(null);
const error = ref<string>('');
const loading = ref(true);
let timer: ReturnType<typeof setInterval> | undefined;

const chartEl = ref<HTMLElement | null>(null);
let chart: IChartApi | null = null;
let series: ISeriesApi<'Candlestick'> | null = null;
let markers: ISeriesMarkersPluginApi<Time> | null = null;
const zonesPrimitive = new ZonesPrimitive();
let drawnZones: Zone[] = [];

function buildChart() {
  if (!chartEl.value || chart) return;
  const dark = settingsStore.chartTheme === 'dark';
  chart = createChart(chartEl.value, {
    autoSize: true,
    layout: {
      background: { color: 'transparent' },
      textColor: dark ? '#d1d4dc' : '#191919',
      attributionLogo: true, // Lightweight Charts licence: attribution to TradingView
    },
    grid: {
      vertLines: { color: dark ? '#2a2e39' : '#eceff1' },
      horzLines: { color: dark ? '#2a2e39' : '#eceff1' },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
  });
  series = chart.addSeries(CandlestickSeries, {
    upColor: colorStore.colorUp,
    downColor: colorStore.colorDown,
    wickUpColor: colorStore.colorUp,
    wickDownColor: colorStore.colorDown,
    borderVisible: false,
  });
  markers = createSeriesMarkers(series, []);
  series.attachPrimitive(zonesPrimitive);
  series.attachPrimitive(drawingsPrimitive);
  chart.subscribeClick(onChartClick);
  chart.subscribeCrosshairMove(onCrosshairMove);
}

/** Replace everything drawn - never append - so a refresh cannot duplicate a drawing. */
function render(fit = false) {
  const s = snapshot.value;
  if (!s || !series || !markers) return;
  series.setData(
    s.candles.map((c) => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })),
  );
  const lastTime = s.candles.at(-1)?.time ?? 0;
  const drawn = inView(s, history.value);
  markers.setMarkers(toMarkers(drawn, enabled.value));
  drawnZones = toZones(drawn, enabled.value, lastTime);
  zonesPrimitive.setZones(drawnZones);
  if (fit) chart?.timeScale().fitContent();
}

function pointAt(param: MouseEventParams<Time>): Point | null {
  if (!param.point || param.time === undefined || !series) return null;
  const price = series.coordinateToPrice(param.point.y);
  if (price === null) return null;
  const time = param.time as number;
  const bar = snapshot.value?.candles.find((c) => c.time === time);
  return { time, price: magnet.value ? snap(price, bar) : price };
}

function commit(next: Drawing[]) {
  undoStack.value = [...undoStack.value.slice(-49), drawings.value];
  drawings.value = next;
}

function onCrosshairMove(param: MouseEventParams<Time>) {
  if (!pending || tool.value === 'cursor') return;
  const p = pointAt(param);
  drawingsPrimitive.update({
    preview: p ? { id: 'preview', tool: tool.value as Drawing['tool'], p1: pending, p2: p } : null,
  });
}

function onDraw(param: MouseEventParams<Time>) {
  if (locked.value) return;
  const p = pointAt(param);
  if (!p) return;
  const t = tool.value as Drawing['tool'];
  const id = `${t}:${Date.now()}`;
  if (!needsTwoPoints(t)) {
    if (t === 'text') {
      const text = window.prompt('Text');
      if (!text) return;
      commit([...drawings.value, { id, tool: t, p1: p, text }]);
    } else {
      commit([...drawings.value, { id, tool: t, p1: p }]);
    }
    return;
  }
  if (!pending) {
    pending = p;
    return;
  }
  commit([...drawings.value, { id, tool: t, p1: pending, p2: p }]);
  pending = null;
  drawingsPrimitive.update({ preview: null });
}

function undo() {
  const prev = undoStack.value.at(-1);
  if (!prev) return;
  undoStack.value = undoStack.value.slice(0, -1);
  drawings.value = prev;
}

function clearDrawings() {
  if (drawings.value.length) commit([]);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    pending = null;
    drawingsPrimitive.update({ preview: null });
    tool.value = 'cursor';
    indicatorsOpen.value = false;
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    undo();
  }
}

const drawKey = computed(() => storageKey(snapshot.value?.symbol ?? 'GOLD', timeframe.value));
watch(drawKey, (key) => {
  drawings.value = loadDrawings(key);
  undoStack.value = [];
});
watch(drawings, (list) => {
  saveDrawings(drawKey.value, list);
  drawingsPrimitive.update({ drawings: list });
}, { deep: true });
watch(hideDrawings, (h) => drawingsPrimitive.update({ hidden: h }));
watch(tool, () => {
  pending = null;
  drawingsPrimitive.update({ preview: null });
});
watch(timeframe, (tf) => drawingsPrimitive.update({ barSeconds: TF_SECONDS[tf] ?? 0 }), { immediate: true });

function onChartClick(param: MouseEventParams<Time>) {
  if (tool.value !== 'cursor') {
    onDraw(param);
    return;
  }
  const obs = snapshot.value?.observations ?? [];
  if (param.hoveredObjectId) {
    selected.value = obs.find((o) => o.observation_id === param.hoveredObjectId) ?? null;
    return;
  }
  if (!param.point || param.time === undefined || !series) return;
  const price = series.coordinateToPrice(param.point.y);
  if (price === null) return;
  const zone = zoneAt(drawnZones, param.time as number, price);
  selected.value = zone ? (obs.find((o) => o.observation_id === zone.id) ?? null) : null;
}

async function fetchObservations(fit = false) {
  if (blocked.value) {
    error.value = blocked.value;
    loading.value = false;
    return;
  }
  try {
    snapshot.value = (await botStore.activeBot.getGoldObservations(timeframe.value)) as Snapshot;
    error.value = '';
    loading.value = false;
    await nextTick();
    buildChart();
    render(fit);
  } catch (e) {
    // Usually the MT5 terminal is not running or not logged in. Say so, and drop the old
    // drawings: a stale chart next to an error reads as current.
    snapshot.value = null;
    error.value = describe(e);
    loading.value = false;
  }
}

watch(timeframe, () => {
  selected.value = null;
  fetchObservations(true);
});
watch(enabled, () => render(), { deep: true });
watch(history, () => render());

const unknownTypes = computed(() => uncategorised(snapshot.value?.observations ?? []));
const counts = computed(() => {
  const out: Record<string, number> = {};
  for (const o of snapshot.value?.observations ?? []) {
    for (const [cat, types] of Object.entries(CATEGORIES)) {
      if (types.includes(o.observation_type)) out[cat] = (out[cat] ?? 0) + 1;
    }
  }
  return out;
});

// ------------------------------------------------------------- market understanding

const state = ref<MarketState | null>(null);
const stateError = ref<string>('');
let stateTimer: ReturnType<typeof setInterval> | undefined;

const decision = ref<DecisionState | null>(null);

async function fetchState() {
  if (blocked.value) {
    stateError.value = blocked.value;
    return;
  }
  try {
    // The decision endpoint returns the market state's verdict, so both come from one
    // pass and cannot disagree about which candle they describe.
    const [stateRes, decisionRes] = await Promise.all([
      botStore.activeBot.getGoldMarketState(),
      botStore.activeBot.getGoldDecision(),
    ]);
    state.value = stateRes as MarketState;
    decision.value = decisionRes as DecisionState;
    stateError.value = '';
  } catch (e) {
    // A stale panel next to a 401 reads as current. Clear it, then show why.
    state.value = null;
    decision.value = null;
    stateError.value = describe(e);
  }
}

// SETUP_READY must never read as "an order happened". Colour marks it as noteworthy,
// the label under it says explicitly that nothing was placed.
const decisionTone = computed(() => {
  const d = decision.value?.decision;
  if (d === 'SETUP_READY') return 'text-sky-600 dark:text-sky-400';
  if (d === 'REJECT') return 'text-red-600 dark:text-red-400';
  return 'text-neutral-600 dark:text-neutral-300';
});

onMounted(() => {
  window.addEventListener('keydown', onKey);
  fetchObservations(true);
  fetchState();
  timer = setInterval(() => fetchObservations(false), REFRESH_MS);
  stateTimer = setInterval(fetchState, STATE_REFRESH_MS);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  if (timer) clearInterval(timer);
  if (stateTimer) clearInterval(stateTimer);
  chart?.remove();
  chart = null;
  series = null;
  markers = null;
});

const primary = computed(() => {
  const tf = state.value?.market_state?.[PRIMARY_TF];
  return tf?.available ? tf : null;
});

// Colour carries direction only. A condition is not good or bad news - the engine takes
// no position on whether any of this is tradeable.
function directionColor(direction: string | undefined) {
  if (direction === 'up') return colorStore.colorUp;
  if (direction === 'down') return colorStore.colorDown;
  return undefined;
}

const statusTone = computed(() => {
  const s = state.value?.engine_status;
  if (s === 'VALID') return 'text-emerald-600 dark:text-emerald-400';
  if (s === 'DEGRADED') return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
});

function arrow(direction: string) {
  return direction === 'up' ? '▲' : direction === 'down' ? '▼' : '–';
}

function fmt(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined ? '–' : value.toFixed(digits);
}

const lastPrice = computed(() => snapshot.value?.candles.at(-1)?.close);
const change = computed(() => {
  const first = snapshot.value?.candles[0]?.open;
  const last = lastPrice.value;
  if (first === undefined || last === undefined) return undefined;
  return { abs: last - first, pct: ((last - first) / first) * 100 };
});
</script>

<template>
  <div class="flex flex-col h-full md:mx-3 mt-2 px-1">
    <div class="tv-frame">
      <!-- ============ top bar ============ -->
      <div class="tv-top">
        <span class="tv-symbol"><UIcon name="i-mdi-gold" />{{ snapshot?.symbol ?? 'XAUUSD' }}</span>
        <span class="tv-sep" />
        <button
          v-for="tf in TIMEFRAMES"
          :key="tf"
          class="tv-btn"
          :class="{ 'tv-on': tf === timeframe }"
          @click="timeframe = tf"
        >
          {{ TF_LABEL[tf] ?? tf }}
        </button>
        <span class="tv-sep" />
        <div class="relative">
          <button class="tv-btn tv-wide" :class="{ 'tv-on': indicatorsOpen }" @click="indicatorsOpen = !indicatorsOpen">
            <UIcon name="i-mdi-chart-box-outline" /> Indicators <UIcon name="i-mdi-chevron-down" />
          </button>
          <div v-if="indicatorsOpen" class="tv-menu">
            <div class="tv-menu-head">Bot observations</div>
            <div v-for="(_, cat) in CATEGORIES" :key="cat" class="tv-menu-row">
              <label class="flex items-center gap-2 grow cursor-pointer">
                <input v-model="enabled[cat]" type="checkbox" />
                <span class="capitalize">{{ prettyCat(String(cat)) }}</span>
                <span class="tv-count">{{ counts[cat] ?? 0 }}</span>
              </label>
              <button class="tv-icon" :title="favourites.includes(String(cat)) ? 'Unpin from top bar' : 'Pin to top bar'" @click="toggleFavourite(String(cat))">
                <UIcon :name="favourites.includes(String(cat)) ? 'i-mdi-star' : 'i-mdi-star-outline'" />
              </button>
            </div>
            <div class="tv-menu-row">
              <label class="flex items-center gap-2 grow cursor-pointer">
                <input v-model="history" type="checkbox" /> History (all {{ snapshot?.observations.length ?? 0 }})
              </label>
            </div>
          </div>
        </div>
        <button
          v-for="cat in favourites"
          :key="'fav-' + cat"
          class="tv-btn tv-chip capitalize"
          :class="{ 'tv-on': enabled[cat] }"
          :title="'Toggle ' + prettyCat(cat)"
          @click="enabled[cat] = !enabled[cat]"
        >
          <UIcon name="i-mdi-star" class="tv-star" /> {{ prettyCat(cat) }}
        </button>
        <button class="tv-btn" :class="{ 'tv-on': history }" title="Show every stored observation" @click="history = !history">
          <UIcon name="i-mdi-history" />
        </button>
        <button class="tv-btn" title="Undo (Ctrl+Z)" :disabled="!undoStack.length" @click="undo"><UIcon name="i-mdi-undo" /></button>
        <button class="tv-btn" title="Refresh" @click="fetchObservations(false)"><UIcon name="i-mdi-refresh" /></button>
        <span class="ms-auto flex items-center gap-2">
          <span v-if="snapshot?.data_cutoff" class="tv-muted">closed {{ new Date(snapshot.data_cutoff).toLocaleTimeString() }}</span>
          <span v-if="lastPrice !== undefined" class="font-bold">{{ lastPrice.toFixed(2) }}</span>
          <span
            v-if="change"
            class="font-semibold"
            :style="{ color: change.abs >= 0 ? colorStore.colorUp : colorStore.colorDown }"
          >
            {{ change.abs >= 0 ? '+' : '' }}{{ change.abs.toFixed(2) }} ({{ change.pct >= 0 ? '+' : '' }}{{ change.pct.toFixed(2) }}%)
          </span>
        </span>
      </div>

      <div class="tv-body">
        <!-- ============ left toolbar ============ -->
        <div class="tv-left">
          <button
            v-for="t in TOOLS"
            :key="t.id"
            class="tv-tool"
            :class="{ 'tv-on': tool === t.id }"
            :title="t.label"
            @click="tool = t.id"
          >
            <UIcon :name="t.icon" />
          </button>
          <span class="tv-hsep" />
          <button class="tv-tool" :class="{ 'tv-on': magnet }" title="Magnet: snap to open/high/low/close" @click="magnet = !magnet">
            <UIcon name="i-mdi-magnet" />
          </button>
          <button class="tv-tool" :class="{ 'tv-on': locked }" title="Lock drawings" @click="locked = !locked">
            <UIcon :name="locked ? 'i-mdi-lock' : 'i-mdi-lock-open-variant-outline'" />
          </button>
          <button class="tv-tool" :class="{ 'tv-on': hideDrawings }" title="Hide my drawings" @click="hideDrawings = !hideDrawings">
            <UIcon :name="hideDrawings ? 'i-mdi-eye-off-outline' : 'i-mdi-eye-outline'" />
          </button>
          <button class="tv-tool" title="Remove all my drawings (Ctrl+Z undoes)" @click="clearDrawings">
            <UIcon name="i-mdi-delete-outline" />
          </button>
          <span class="grow" />
          <button class="tv-tool" :class="{ 'tv-on': indicatorsOpen }" title="Favourites" @click="indicatorsOpen = !indicatorsOpen">
            <UIcon name="i-mdi-star-outline" />
          </button>
        </div>

        <!-- ============ chart ============ -->
        <div class="tv-chart-wrap">
          <div
            v-if="snapshot && (snapshot.warnings.length || unknownTypes.length)"
            class="tv-warn"
          >
            <span v-for="w in snapshot.warnings" :key="w" class="me-3">&#9888; {{ w }}</span>
            <span v-if="unknownTypes.length">&#9888; not drawn (no category): {{ unknownTypes.join(', ') }}</span>
          </div>
          <div v-if="error" class="p-3 text-sm">
            Could not load the gold chart: {{ error }}
            <div v-if="blocked" class="tv-muted mt-1">
              These routes require a bot login on this server. The chart stays blank rather than
              showing an empty candle series, because an empty series reads as a flat market.
            </div>
            <div v-else-if="error.startsWith('Not authorised')" class="tv-muted mt-1">
              Log in to the bot again from the Bots page, then reload.
            </div>
            <div v-else class="tv-muted mt-1">
              Check that the MT5 terminal is running and logged into a trade account.
            </div>
          </div>
          <div v-else-if="loading" class="p-3 text-sm tv-muted">Loading candles&hellip;</div>
          <div v-show="!error && !loading" ref="chartEl" class="gold-chart" :class="{ 'tv-drawing': tool !== 'cursor' }" />
        </div>
      </div>
    </div>

    <div
      v-if="selected"
      class="mt-2 border dark:border-neutral-700 border-neutral-300 rounded-md p-2 text-xs grid md:grid-cols-4 gap-x-4 gap-y-1"
    >
      <div class="md:col-span-4 flex items-center gap-2">
        <span class="font-bold">{{ selected.label }}</span>
        <span class="text-neutral-500">
          {{ selected.observation_type }} &middot; {{ selected.direction ?? 'no direction' }}
        </span>
        <span class="ms-auto font-mono text-neutral-500">{{ selected.observation_id }}</span>
        <UButton size="xs" variant="ghost" @click="selected = null">close</UButton>
      </div>
      <div>
        <span class="text-neutral-500">Price</span> {{ fmt(selected.lower_price) }}
        <span v-if="selected.upper_price !== selected.lower_price">
          &ndash; {{ fmt(selected.upper_price) }}
        </span>
      </div>
      <div>
        <span class="text-neutral-500">Status</span> {{ selected.status }}
        <span v-if="selected.status_timestamp">
          @ {{ new Date(selected.status_timestamp).toLocaleString() }}
        </span>
      </div>
      <div>
        <span class="text-neutral-500">Formed</span>
        {{ new Date(selected.formation_timestamp).toLocaleString() }}
      </div>
      <div>
        <span class="text-neutral-500">Knowable</span>
        {{ new Date(selected.first_available_timestamp).toLocaleString() }}
      </div>
      <div><span class="text-neutral-500">Timeframe</span> {{ selected.source_timeframe }}</div>
      <div class="md:col-span-2">
        <span class="text-neutral-500">Detector</span>
        {{ selected.detector_id }} &middot; {{ selected.detector_version }}
      </div>
      <div>
        <span class="text-neutral-500">Quality</span> {{ selected.quality_status }}
        <span v-if="(selected.detections ?? 1) > 1">
          &middot; {{ selected.detections }} detections merged
        </span>
      </div>
    </div>

    <details v-if="snapshot" class="text-xs mt-1">
      <summary class="cursor-pointer text-neutral-500">Not drawn, and why</summary>
      <ul class="list-disc ms-4 text-neutral-500">
        <li v-for="(why, name) in snapshot.unresolved" :key="name">
          <b>{{ name }}</b>: {{ why }}
        </li>
      </ul>
      <div class="text-neutral-500 mt-1">
        Source {{ snapshot.source }} &middot; {{ snapshot.schema_version }} &middot;
        {{ snapshot.engine_version }}
      </div>
    </details>

    <UCard class="mt-2" :ui="{ body: 'p-3 sm:p-3' }">
      <div class="flex flex-wrap items-baseline gap-3 mb-2">
        <span class="text-sm font-bold uppercase tracking-wide">Market understanding</span>
        <span class="text-xs text-neutral-500">
          analysis only &middot; places no orders
        </span>
        <span v-if="state" class="ms-auto text-xs" :class="statusTone">
          {{ state.engine_status }} &middot; data {{ state.data_quality }}
        </span>
      </div>

      <div v-if="stateError" class="text-sm">
        Market state unavailable: {{ stateError }}
        <div class="text-neutral-500 mt-1">
          The engine needs the MT5 terminal running and logged in.
        </div>
      </div>
      <div v-else-if="!state" class="text-sm text-neutral-500">Reading the market&hellip;</div>

      <template v-else>
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2 mb-3">
          <div>
            <div class="text-xs text-neutral-500">Condition</div>
            <div class="text-lg font-bold">{{ state.condition.replace(/_/g, ' ') }}</div>
          </div>
          <div>
            <div class="text-xs text-neutral-500">Session</div>
            <div class="font-semibold">{{ state.session }}</div>
          </div>
          <div>
            <div class="text-xs text-neutral-500">Timeframes</div>
            <div class="font-semibold">{{ state.mtf_context.agreement.replace(/_/g, ' ') }}</div>
          </div>
          <div class="ms-auto text-end">
            <div class="text-xs text-neutral-500">Decision</div>
            <div class="text-lg font-bold" :class="decisionTone">
              {{ decision ? decision.decision.replace(/_/g, ' ') : state.decision }}
              <span v-if="decision?.direction" class="text-sm">
                &middot; {{ decision.direction }}
              </span>
            </div>
            <div class="text-xs text-neutral-500">
              analysis only &mdash; no order placed
            </div>
          </div>
        </div>

        <!-- Why the decision came out that way, in the engine's own reason codes. -->
        <div
          v-if="decision"
          class="border dark:border-neutral-700 border-neutral-300 rounded-md p-2 mb-3 text-xs"
        >
          <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span class="text-neutral-500">Candidate setup</span>
            <span class="font-semibold">{{ decision.candidate_strategy ?? 'none' }}</span>
            <span class="text-neutral-500">Trading enabled</span>
            <span class="font-semibold">{{ decision.trading_enabled ? 'TRUE' : 'FALSE' }}</span>
            <span v-if="decision.valid_until" class="text-neutral-500">Valid until</span>
            <span v-if="decision.valid_until" class="font-semibold">
              {{ new Date(decision.valid_until).toLocaleTimeString() }}
            </span>
          </div>
          <div class="mt-2 grid md:grid-cols-3 gap-x-4 gap-y-1">
            <div>
              <span class="text-neutral-500">Reasons:</span>
              <span class="font-mono">{{ decision.reason_codes.join(', ') || '–' }}</span>
            </div>
            <div v-if="decision.conditions_missing.length">
              <span class="text-neutral-500">Missing:</span>
              <span class="font-mono">{{ decision.conditions_missing.join(', ') }}</span>
            </div>
            <div v-if="decision.blocking_conditions.length">
              <span class="text-neutral-500">Blocking:</span>
              <span class="font-mono text-red-600 dark:text-red-400">
                {{ decision.blocking_conditions.join(', ') }}
              </span>
            </div>
          </div>
          <div
            v-if="decision.reason_codes.includes('NO_APPROVED_SETUP')"
            class="mt-2 text-neutral-500"
          >
            No setup has passed out-of-sample validation, so there is nothing for the
            engine to mark ready. This is the intended state until research produces one.
          </div>
        </div>

        <!-- Per-timeframe direction, so a disagreement is visible rather than averaged away. -->
        <div class="flex flex-wrap gap-2 mb-3">
          <div
            v-for="(tf, name) in state.market_state"
            :key="name"
            class="border dark:border-neutral-700 border-neutral-300 rounded-md px-2 py-1 text-xs"
          >
            <span class="font-bold">{{ name }}</span>
            <span
              v-if="tf.available"
              class="ms-2 font-semibold"
              :style="{ color: directionColor(tf.trend.direction) }"
            >
              {{ arrow(tf.trend.direction) }} {{ tf.condition.replace(/_/g, ' ') }}
            </span>
            <span v-else class="ms-2 text-neutral-500">{{ tf.reason }}</span>
            <span v-if="tf.available && !tf.data.fresh" class="ms-2 text-amber-500">stale</span>
          </div>
        </div>

        <div v-if="primary" class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs mb-3">
          <div>
            <div class="text-neutral-500">Structure ({{ PRIMARY_TF }})</div>
            <div class="font-semibold">
              {{ primary.structure.state }}
              <span v-if="primary.structure.last_bos" class="text-neutral-500">
                &middot; BOS {{ primary.structure.last_bos }}
                {{ primary.structure.bars_since_bos }} bars ago
              </span>
            </div>
          </div>
          <div>
            <div class="text-neutral-500">Momentum</div>
            <div class="font-semibold">
              {{ primary.momentum.state }} &middot; {{ primary.momentum.change }}
              <span class="text-neutral-500">({{ fmt(primary.momentum.roc_atr) }} ATR)</span>
            </div>
          </div>
          <div>
            <div class="text-neutral-500">Volatility</div>
            <div class="font-semibold">
              {{ primary.volatility.regime }}
              {{ primary.volatility.expanding ? '· expanding' : '· contracting' }}
              <span class="text-neutral-500">(ATR {{ fmt(primary.volatility.atr) }})</span>
            </div>
          </div>
          <div>
            <div class="text-neutral-500">Range position</div>
            <div class="font-semibold">
              {{ primary.range.position === null ? '–' : (primary.range.position * 100).toFixed(0) + '%' }}
              <span class="text-neutral-500">
                of {{ fmt(primary.range.low) }}–{{ fmt(primary.range.high) }}
              </span>
            </div>
          </div>
          <div>
            <div class="text-neutral-500">Support / resistance</div>
            <div class="font-semibold">
              {{ fmt(primary.support_resistance.support) }} /
              {{ fmt(primary.support_resistance.resistance) }}
            </div>
          </div>
          <div>
            <div class="text-neutral-500">Nearby liquidity</div>
            <div class="font-semibold">
              {{ fmt(primary.liquidity.recent_low) }} / {{ fmt(primary.liquidity.recent_high) }}
              <span class="text-neutral-500">
                ({{ primary.liquidity.equal_lows }} / {{ primary.liquidity.equal_highs }} equal)
              </span>
            </div>
          </div>
          <div>
            <div class="text-neutral-500">Last closed {{ PRIMARY_TF }}</div>
            <div class="font-semibold">
              {{ new Date(primary.data.last_closed).toLocaleTimeString() }}
              <span class="text-neutral-500">({{ fmt(primary.data.age_minutes, 0) }}m ago)</span>
            </div>
          </div>
          <div>
            <div class="text-neutral-500">Engine</div>
            <div class="font-semibold">{{ state.engine_version }}</div>
          </div>
        </div>

        <!-- Facts the condition was drawn from, kept separate from the conclusion above. -->
        <details class="text-xs">
          <summary class="cursor-pointer text-neutral-500">
            Evidence, warnings and what is not known
          </summary>
          <div class="mt-2 grid md:grid-cols-3 gap-4">
            <div>
              <div class="font-semibold mb-1">Evidence</div>
              <ul class="list-disc ms-4 text-neutral-500">
                <li v-for="e in state.condition_evidence" :key="e">{{ e }}</li>
              </ul>
            </div>
            <div>
              <div class="font-semibold mb-1">Warnings</div>
              <ul v-if="state.warnings.length" class="list-disc ms-4 text-amber-600 dark:text-amber-400">
                <li v-for="w in state.warnings" :key="w">{{ w }}</li>
              </ul>
              <div v-else class="text-neutral-500">none</div>
            </div>
            <div>
              <div class="font-semibold mb-1">Not established</div>
              <ul v-if="state.unknown.length" class="list-disc ms-4 text-neutral-500">
                <li v-for="u in state.unknown" :key="u">{{ u }}</li>
              </ul>
              <div v-else class="text-neutral-500">none</div>
            </div>
          </div>
        </details>
      </template>
    </UCard>
  </div>
</template>

<style scoped>
.tv-frame {
  border: 1px solid #2a2e39;
  border-radius: 4px;
  background: #131722;
  color: #d1d4dc;
  font-size: 12px;
  overflow: visible;
}
.tv-top {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 38px;
  padding: 0 6px;
  border-bottom: 1px solid #2a2e39;
  flex-wrap: nowrap;
  overflow-x: auto;
}
.tv-symbol {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 14px;
  background: #1e222d;
  font-weight: 700;
}
.tv-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 28px;
  min-width: 28px;
  padding: 0 6px;
  border-radius: 4px;
  color: #d1d4dc;
  white-space: nowrap;
}
.tv-btn:hover:not(:disabled),
.tv-tool:hover,
.tv-icon:hover {
  background: #2a2e39;
}
.tv-btn:disabled {
  opacity: 0.35;
}
.tv-on {
  background: #2a2e39;
  color: #2962ff;
}
.tv-chip {
  font-size: 11px;
}
.tv-star {
  color: #f7c948;
}
.tv-sep {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: #2a2e39;
}
.tv-menu {
  position: absolute;
  top: 32px;
  left: 0;
  z-index: 50;
  width: 260px;
  padding: 4px 0;
  border: 1px solid #2a2e39;
  border-radius: 6px;
  background: #1e222d;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.tv-menu-head {
  padding: 6px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #787b86;
}
.tv-menu-row {
  display: flex;
  align-items: center;
  padding: 5px 12px;
}
.tv-menu-row:hover {
  background: #2a2e39;
}
.tv-count {
  margin-left: auto;
  color: #787b86;
}
.tv-icon {
  margin-left: 8px;
  padding: 2px;
  border-radius: 3px;
  color: #f7c948;
}
.tv-body {
  display: flex;
}
.tv-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 42px;
  padding: 6px 0;
  border-right: 1px solid #2a2e39;
}
.tv-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 4px;
  font-size: 18px;
  color: #d1d4dc;
}
.tv-hsep {
  width: 24px;
  height: 1px;
  margin: 4px 0;
  background: #2a2e39;
}
.tv-chart-wrap {
  flex: 1;
  min-width: 0;
}
.tv-warn {
  padding: 2px 8px;
  font-size: 11px;
  color: #f7a600;
}
.tv-muted {
  color: #787b86;
}
.tv-drawing {
  cursor: crosshair;
}
.gold-chart {
  width: 100%;
  min-height: 380px;
  /* Leaves room for the market-understanding panel below. */
  height: calc(100vh - 430px);
}
</style>
