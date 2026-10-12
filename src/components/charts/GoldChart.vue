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
  toMarkers,
  toZones,
  uncategorised,
  zoneAt,
  type Observation,
  type Snapshot,
  type Zone,
} from './goldOverlays';

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
const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
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
  chart.subscribeClick(onChartClick);
}

/** Replace everything drawn - never append - so a refresh cannot duplicate a drawing. */
function render(fit = false) {
  const s = snapshot.value;
  if (!s || !series || !markers) return;
  series.setData(
    s.candles.map((c) => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })),
  );
  const lastTime = s.candles.at(-1)?.time ?? 0;
  markers.setMarkers(toMarkers(s.observations, enabled.value));
  drawnZones = toZones(s.observations, enabled.value, lastTime);
  zonesPrimitive.setZones(drawnZones);
  if (fit) chart?.timeScale().fitContent();
}

function onChartClick(param: MouseEventParams<Time>) {
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
  fetchObservations(true);
  fetchState();
  timer = setInterval(() => fetchObservations(false), REFRESH_MS);
  stateTimer = setInterval(fetchState, STATE_REFRESH_MS);
});
onUnmounted(() => {
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
    <UCard class="flex-fill" :ui="{ body: 'p-3 sm:p-3 h-full' }">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-xl font-bold">XAUUSD</span>
        <span class="text-sm text-neutral-500">
          {{ snapshot?.symbol ?? 'Gold' }} &middot; {{ timeframe }} &middot; MT5
          <span v-if="snapshot?.data_cutoff">
            &middot; closed to {{ new Date(snapshot.data_cutoff).toLocaleTimeString() }}
          </span>
        </span>
        <span v-if="lastPrice !== undefined" class="ms-auto text-xl font-bold">
          {{ lastPrice.toFixed(2) }}
        </span>
        <span
          v-if="change"
          class="text-sm font-semibold"
          :style="{ color: change.abs >= 0 ? colorStore.colorUp : colorStore.colorDown }"
        >
          {{ change.abs >= 0 ? '+' : '' }}{{ change.abs.toFixed(2) }}
          ({{ change.pct >= 0 ? '+' : '' }}{{ change.pct.toFixed(2) }}%)
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-2 mb-2 text-xs">
        <UButton
          v-for="tf in TIMEFRAMES"
          :key="tf"
          size="xs"
          :variant="tf === timeframe ? 'solid' : 'outline'"
          @click="timeframe = tf"
        >
          {{ tf }}
        </UButton>
        <label v-for="(_, cat) in CATEGORIES" :key="cat" class="flex items-center gap-1 ms-2">
          <input v-model="enabled[cat]" type="checkbox" />
          {{ String(cat).replace(/_/g, ' ') }} ({{ counts[cat] ?? 0 }})
        </label>
      </div>

      <div
        v-if="snapshot && (snapshot.warnings.length || unknownTypes.length)"
        class="text-xs text-amber-600 dark:text-amber-400 mb-1"
      >
        <span v-for="w in snapshot.warnings" :key="w" class="me-3">&#9888; {{ w }}</span>
        <span v-if="unknownTypes.length">
          &#9888; not drawn (no category): {{ unknownTypes.join(', ') }}
        </span>
      </div>

      <div
        v-if="error"
        class="border dark:border-neutral-700 border-neutral-300 rounded-md p-3 text-sm"
      >
        Could not load the gold chart: {{ error }}
        <div v-if="blocked" class="text-neutral-500 mt-1">
          These routes require a bot login on this server. The chart stays blank rather than
          showing an empty candle series, because an empty series reads as a flat market.
        </div>
        <div v-else-if="error.startsWith('Not authorised')" class="text-neutral-500 mt-1">
          Log in to the bot again from the Bots page, then reload.
        </div>
        <div v-else class="text-neutral-500 mt-1">
          Check that the MT5 terminal is running and logged into a trade account.
        </div>
      </div>
      <div v-else-if="loading" class="text-sm text-neutral-500 p-3">Loading candles&hellip;</div>
      <div v-show="!error && !loading" ref="chartEl" class="gold-chart" />

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
    </UCard>

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
.gold-chart {
  width: 100%;
  min-height: 360px;
  /* Leaves room for the controls and the market-understanding panel below. */
  height: calc(100vh - 520px);
}
</style>
