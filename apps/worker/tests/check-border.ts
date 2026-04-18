// Ad-hoc: run the border detector against a live puzzle image.
// Usage: npx tsx tests/check-border.ts <url>

import { detectBorder } from '../src/lib/image'

async function main() {
  const url = process.argv[2] || 'https://xefig.com/cdn/puzzles/2026-03-22/diamond.jpg?v=1776550434995'
  console.log('Fetching', url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  console.log('Bytes:', bytes.length)

  const detection = detectBorder(bytes)

  console.log('\nPer-edge stats:')
  for (const e of detection.edges) {
    console.log(
      `  ${e.edge.padEnd(6)} outerMean=(${e.outerMean.map((v) => v.toFixed(1)).join(',')})`,
      `outerStd=${e.outerStd.toFixed(2)}`,
      `innerMean=(${e.innerMean.map((v) => v.toFixed(1)).join(',')})`,
      `dist=${e.meanDistance.toFixed(2)}`,
      `flagged=${e.flagged}`,
    )
  }
  console.log('\nhasBorder:', detection.hasBorder)
  console.log('flaggedEdges:', detection.flaggedEdges.join(',') || '(none)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
