import test from 'node:test'
import assert from 'node:assert/strict'

import { compareIsoTimestamps, mergeCompletedEntry } from '../src/lib/sync'

test('mergeCompletedEntry keeps the best time and the newer completion metadata', () => {
  const merged = mergeCompletedEntry(
    {
      difficulty: 'hard',
      elapsedActiveMs: 95_000,
      bestElapsedMs: 95_000,
      completedAt: '2026-04-03T09:00:00.000Z',
    },
    {
      difficulty: 'hard',
      elapsedActiveMs: 120_000,
      bestElapsedMs: 120_000,
      completedAt: '2026-04-03T10:00:00.000Z',
    },
  )

  assert.deepEqual(merged, {
    difficulty: 'hard',
    elapsedActiveMs: 120_000,
    bestElapsedMs: 95_000,
    completedAt: '2026-04-03T10:00:00.000Z',
  })
})

test('compareIsoTimestamps orders valid timestamps and tolerates blanks', () => {
  assert.equal(compareIsoTimestamps('2026-04-03T10:00:00.000Z', '2026-04-03T09:00:00.000Z') > 0, true)
  assert.equal(compareIsoTimestamps('', '2026-04-03T09:00:00.000Z') < 0, true)
  assert.equal(compareIsoTimestamps('', ''), 0)
})

