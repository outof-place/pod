// Prints summary.json as Markdown tables: every metric, then every Pod-vs-Orca comparison, then the
// rows still coming.
//
//   node bench/report.mjs results/<date>/summary.json
import { readFileSync } from 'node:fs'

const summary = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const format = (value) =>
  value === null || value === undefined
    ? '-'
    : Math.abs(value) >= 100
      ? value.toFixed(0)
      : Math.abs(value) >= 10
        ? value.toFixed(1)
        : value.toFixed(2)

console.log('| Benchmark | Subject | Median | p95 | n | Unit |')
console.log('|---|---|---:|---:|---:|---|')
for (const row of summary.metrics) {
  console.log(
    `| ${row.metric} | ${row.subject} | ${format(row.median)} | ${format(row.p95)} | ${row.n ?? '-'} | ${row.unit} |`
  )
}
console.log('\n| Comparison | Baseline | Candidate | Result |')
console.log('|---|---|---|---|')
for (const row of summary.comparisons) {
  const verdict =
    row.factor >= 1 ? `${row.factor.toFixed(2)}x better` : `${(1 / row.factor).toFixed(2)}x worse`
  console.log(
    `| ${row.label ?? row.metric} | ${row.baseline.subject}: ${format(row.baseline.median)} ${row.unit} | ${row.candidate.subject}: ${format(row.candidate.median)} ${row.unit} | ${verdict} |`
  )
}
if (summary.coming?.length > 0) {
  console.log('\n| Coming | Suite | Why no number yet |')
  console.log('|---|---|---|')
  for (const row of summary.coming) {
    console.log(`| ${row.subject} | ${row.suite} | ${row.reason} |`)
  }
}
