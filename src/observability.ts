// Lightweight observability wrapper. Uses prom-client when installed; otherwise no-ops.

type RegistryLike = {
  metrics: () => Promise<string> | string;
};

let registry: RegistryLike | null = null;

type CounterLike = {
  inc: (labels?: Record<string, string>, value?: number) => void;
};

type HistogramLike = {
  observe: (labels: Record<string, string>, value: number) => void;
};

let counter: CounterLike | null = null;
let searchHistogram: HistogramLike | null = null;
let searchCounter: CounterLike | null = null;

async function init() {
  if (registry) return { registry, counter, searchHistogram, searchCounter };
  try {
    const prom = await import('prom-client');
    registry = prom.register as RegistryLike;

    if (typeof prom.Counter === 'function') {
      const CounterClass = prom.Counter as unknown as new (opts: { name: string; help: string; labelNames?: string[] }) => CounterLike;
      try { counter = new CounterClass({ name: 'actual_tool_calls_total', help: 'Total tool calls', labelNames: ['tool'] }); } catch { counter = noopCounter; }
      try { searchCounter = new CounterClass({ name: 'actual_search_queries_total', help: 'Search queries', labelNames: ['mode', 'intent'] }); } catch { searchCounter = noopCounter; }
    } else {
      counter = noopCounter;
      searchCounter = noopCounter;
    }

    if (typeof (prom as any).Histogram === 'function') {
      const HistClass = (prom as any).Histogram as new (opts: { name: string; help: string; labelNames?: string[]; buckets?: number[] }) => HistogramLike;
      try { searchHistogram = new HistClass({ name: 'actual_search_duration_ms', help: 'Search latency', labelNames: ['mode'], buckets: [5, 10, 25, 50, 100, 250, 500, 1000] }); } catch { searchHistogram = noopHistogram; }
    } else {
      searchHistogram = noopHistogram;
    }

    return { registry, counter, searchHistogram, searchCounter };
  } catch {
    registry = null;
    counter = noopCounter;
    searchHistogram = noopHistogram;
    searchCounter = noopCounter;
    return { registry, counter, searchHistogram, searchCounter };
  }
}

const noopCounter: CounterLike = { inc: () => { } };
const noopHistogram: HistogramLike = { observe: () => { } };

export async function incrementToolCall(toolName: string) {
  const { counter } = await init();
  try { counter?.inc({ tool: toolName }, 1); } catch { /* noop */ }
}

export async function recordSearchQuery(mode: string, intent: string, durationMs: number) {
  const { searchCounter, searchHistogram } = await init();
  try {
    searchCounter?.inc({ mode, intent }, 1);
    searchHistogram?.observe({ mode }, durationMs);
  } catch { /* noop */ }
}

export async function getMetricsText(): Promise<string | null> {
  const { registry } = await init();
  if (!registry) return null;
  const m = registry.metrics();
  if (typeof m === 'string') return m;
  return await m;
}

export default { incrementToolCall, recordSearchQuery, getMetricsText };
