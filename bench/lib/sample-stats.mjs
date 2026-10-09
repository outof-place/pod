import {
  summarizeBenchmarkSamples,
  BENCHMARK_SAMPLE_AGGREGATION
} from '../../config/scripts/benchmark-sample-summary.mjs'

export { BENCHMARK_SAMPLE_AGGREGATION }

/** Median (average of the middle pair), nearest-rank p95, min and max, in the samples' own unit. */
export function summarize(values, unit) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) {
    return null
  }
  // The shared helper rounds to 0.1; scale so sub-unit values (µs, ratios) keep 3 decimals.
  const scaled = summarizeBenchmarkSamples(finite.map((value) => value * 100))
  return {
    unit,
    n: scaled.samples,
    median: round(scaled.medianMs / 100),
    p95: round(scaled.p95Ms / 100),
    min: round(scaled.minMs / 100),
    max: round(scaled.maxMs / 100)
  }
}

function round(value) {
  return Number(value.toFixed(3))
}
