import test from 'node:test'
import assert from 'node:assert/strict'

import { collapseChanges, compareIsoTimestamps, mergeCompletedEntry } from '../src/lib/sync'

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

test('collapseChanges keeps the latest state per entity key', () => {
  const collapsed = collapseChanges([
    {
      id: 11,
      revision: 3,
      entity_type: 'settings',
      entity_key: 'settings',
      payload: JSON.stringify({ profileName: 'Alpha', boardColorIndex: 1 }),
    },
    {
      id: 12,
      revision: 3,
      entity_type: 'active',
      entity_key: '2026-04-03:jigsaw',
      payload: JSON.stringify({
        puzzleDate: '2026-04-03',
        gameMode: 'jigsaw',
        difficulty: 'medium',
        imageUrl: '/image-a.jpg',
        elapsedActiveMs: 4_000,
        puzzleState: { pieces: 3 },
        updatedAt: '2026-04-03T10:00:00.000Z',
      }),
    },
    {
      id: 13,
      revision: 4,
      entity_type: 'active_deleted',
      entity_key: '2026-04-03:jigsaw',
      payload: JSON.stringify({
        puzzleDate: '2026-04-03',
        gameMode: 'jigsaw',
        deletedAt: '2026-04-03T10:05:00.000Z',
      }),
    },
    {
      id: 14,
      revision: 5,
      entity_type: 'active',
      entity_key: '2026-04-03:jigsaw',
      payload: JSON.stringify({
        puzzleDate: '2026-04-03',
        gameMode: 'jigsaw',
        difficulty: 'medium',
        imageUrl: '/image-b.jpg',
        elapsedActiveMs: 9_000,
        puzzleState: { pieces: 8 },
        updatedAt: '2026-04-03T10:07:00.000Z',
      }),
    },
    {
      id: 15,
      revision: 5,
      entity_type: 'completed',
      entity_key: '2026-04-03:swap',
      payload: JSON.stringify({
        puzzleDate: '2026-04-03',
        gameMode: 'swap',
        difficulty: 'easy',
        elapsedActiveMs: 30_000,
        bestElapsedMs: 28_000,
        completedAt: '2026-04-03T10:08:00.000Z',
      }),
    },
    {
      id: 16,
      revision: 6,
      entity_type: 'settings',
      entity_key: 'settings',
      payload: JSON.stringify({ profileName: 'Beta', boardColorIndex: 2 }),
    },
  ])

  assert.deepEqual(collapsed.settings, { profileName: 'Beta', boardColorIndex: 2 })
  assert.equal(collapsed.deletedActiveRuns.length, 0)
  assert.equal(collapsed.activeRuns.length, 1)
  assert.deepEqual(collapsed.activeRuns[0], {
    puzzleDate: '2026-04-03',
    gameMode: 'jigsaw',
    difficulty: 'medium',
    imageUrl: '/image-b.jpg',
    elapsedActiveMs: 9_000,
    puzzleState: { pieces: 8 },
    updatedAt: '2026-04-03T10:07:00.000Z',
  })
  assert.deepEqual(collapsed.completedRuns[0], {
    puzzleDate: '2026-04-03',
    gameMode: 'swap',
    difficulty: 'easy',
    elapsedActiveMs: 30_000,
    bestElapsedMs: 28_000,
    completedAt: '2026-04-03T10:08:00.000Z',
  })
})
