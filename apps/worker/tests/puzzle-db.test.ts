import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Lightweight D1 mock backed by a Map
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function createMockDB() {
  const tables: Record<string, Row[]> = {}
  const autoInc: Record<string, number> = {}

  function ensureTable(name: string) {
    if (!tables[name]) {
      tables[name] = []
      autoInc[name] = 0
    }
  }

  function getTableName(sql: string): string {
    const m = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i)
    return m ? m[1] : ''
  }

  function evalCondition(row: Row, col: string, op: string, val: unknown): boolean {
    const rv = row[col]
    if (op === '=') return rv === val
    if (op === '>=') return (rv as string) >= (val as string)
    if (op === '<') return (rv as string) < (val as string)
    if (op === '<=') return (rv as string) <= (val as string)
    if (op === '>') return (rv as string) > (val as string)
    return true
  }

  function applyWhere(rows: Row[], sql: string, binds: unknown[]): Row[] {
    const whereIdx = sql.search(/\bWHERE\b/i)
    if (whereIdx === -1) return rows

    const beforeWhere = (sql.substring(0, whereIdx).match(/\?/g) || []).length
    let bindIdx = beforeWhere

    const afterWhere = sql.substring(whereIdx)
    const condRegex = /(\w+)\s*(=|>=|<=|<|>)\s*\?/g
    const conditions: Array<{ col: string; op: string; val: unknown }> = []
    let m
    while ((m = condRegex.exec(afterWhere)) !== null) {
      conditions.push({ col: m[1], op: m[2], val: binds[bindIdx++] })
    }

    return rows.filter((row) => conditions.every((c) => evalCondition(row, c.col, c.op, c.val)))
  }

  function applyOrderBy(rows: Row[], sql: string): Row[] {
    const m = sql.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)/i)
    if (!m) return rows
    const col = m[1]
    const desc = m[2].toUpperCase() === 'DESC'
    return [...rows].sort((a, b) => {
      if ((a[col] as string) < (b[col] as string)) return desc ? 1 : -1
      if ((a[col] as string) > (b[col] as string)) return desc ? -1 : 1
      return 0
    })
  }

  function applyLimit(rows: Row[], sql: string, binds: unknown[]): Row[] {
    const limitIdx = sql.search(/\bLIMIT\b/i)
    if (limitIdx === -1) return rows
    const bindsBefore = (sql.substring(0, limitIdx).match(/\?/g) || []).length
    const limit = binds[bindsBefore] as number
    return rows.slice(0, limit)
  }

  const db = {
    _tables: tables,
    prepare: (sql: string) => {
      let boundArgs: unknown[] = []
      const stmt = {
        bind: (...args: unknown[]) => {
          boundArgs = args
          return stmt
        },
        first: async <T = Row>(): Promise<T | null> => {
          const result = await stmt.all<T>()
          return result.results[0] ?? null
        },
        all: async <T = Row>(): Promise<{ results: T[] }> => {
          if (!sql.trim().toUpperCase().startsWith('SELECT')) return { results: [] }
          const table = getTableName(sql)
          ensureTable(table)
          let rows = applyWhere([...tables[table]], sql, boundArgs)
          rows = applyOrderBy(rows, sql)
          rows = applyLimit(rows, sql, boundArgs)
          return { results: rows as T[] }
        },
        run: async () => {
          const upper = sql.trim().toUpperCase()

          if (upper.startsWith('CREATE')) return {}

          if (upper.startsWith('INSERT')) {
            const m = sql.match(
              /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
            )
            if (!m) return {}
            const table = m[1]
            const cols = m[2].split(',').map((c) => c.trim())
            ensureTable(table)

            const row: Row = {}
            for (let i = 0; i < cols.length; i++) {
              row[cols[i]] = boundArgs[i]
            }

            if (upper.includes('OR REPLACE')) {
              const pkCol = cols[0]
              tables[table] = tables[table].filter((r) => r[pkCol] !== row[pkCol])
            }

            if (row.id === undefined && table === 'prompt_history') {
              autoInc[table] = (autoInc[table] || 0) + 1
              row.id = autoInc[table]
            }

            tables[table].push(row)
            return {}
          }

          if (upper.startsWith('DELETE')) {
            const table = getTableName(sql)
            ensureTable(table)
            if (sql.search(/\bWHERE\b/i) === -1) {
              tables[table] = []
            } else if (sql.includes('NOT IN')) {
              const limitBind = boundArgs[boundArgs.length - 1] as number
              const sorted = [...tables[table]].sort(
                (a, b) => (b.id as number) - (a.id as number),
              )
              const keep = new Set(sorted.slice(0, limitBind).map((r) => r.id))
              tables[table] = tables[table].filter((r) => keep.has(r.id))
            } else {
              tables[table] = applyWhere(tables[table], sql, boundArgs).length === 0
                ? tables[table]
                : tables[table].filter((r) => !applyWhere([r], sql, boundArgs).length)
            }
            return {}
          }

          return {}
        },
      }
      return stmt
    },
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run()
      return stmts.map(() => ({ results: [] }))
    },
  } as unknown as D1Database

  return db
}

// Reset module-level tablesReady guard between tests
async function loadPuzzleDb() {
  const modulePath = require.resolve('../src/lib/puzzle-db')
  delete require.cache[modulePath]
  return await import('../src/lib/puzzle-db')
}

async function loadPrompts() {
  // Also clear puzzle-db since prompts imports it
  delete require.cache[require.resolve('../src/lib/puzzle-db')]
  delete require.cache[require.resolve('../src/lib/prompts')]
  return await import('../src/lib/prompts')
}

async function loadPuzzles() {
  delete require.cache[require.resolve('../src/lib/puzzle-db')]
  delete require.cache[require.resolve('../src/lib/puzzles')]
  return await import('../src/lib/puzzles')
}

function mkRecord(date: string, categories?: Record<string, unknown>) {
  return {
    date,
    difficulty: 'adaptive',
    categories: categories ?? {
      jigsaw: { imageKey: `puzzles/${date}/jigsaw.jpg`, imageUrl: `/cdn/puzzles/${date}/jigsaw.jpg`, contentType: 'image/jpeg', fileName: 'jigsaw.jpg', theme: 'Test', tags: [] },
      slider: { imageKey: `puzzles/${date}/slider.jpg`, imageUrl: `/cdn/puzzles/${date}/slider.jpg`, contentType: 'image/jpeg', fileName: 'slider.jpg', theme: 'Test', tags: [] },
      swap: { imageKey: `puzzles/${date}/swap.jpg`, imageUrl: `/cdn/puzzles/${date}/swap.jpg`, contentType: 'image/jpeg', fileName: 'swap.jpg', theme: 'Test', tags: [] },
      polygram: { imageKey: `puzzles/${date}/polygram.jpg`, imageUrl: `/cdn/puzzles/${date}/polygram.jpg`, contentType: 'image/jpeg', fileName: 'polygram.jpg', theme: 'Test', tags: [] },
      diamond: { imageKey: `puzzles/${date}/diamond.jpg`, imageUrl: `/cdn/puzzles/${date}/diamond.jpg`, contentType: 'image/jpeg', fileName: 'diamond.jpg', theme: 'Test', tags: [] },
    },
    createdAt: `${date}T00:00:00Z`,
    updatedAt: `${date}T00:00:00Z`,
  }
}

// ===========================
// puzzle-db.ts: Puzzle records
// ===========================

test('ensurePuzzleTables creates tables without error', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)
})

test('getPuzzleByDateD1 returns null for missing date', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)
  assert.equal(await mod.getPuzzleByDateD1(db, '2026-04-06'), null)
})

test('savePuzzleRecord + getPuzzleByDateD1 round-trips', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.savePuzzleRecord(db, mkRecord('2026-04-06') as any)
  const result = await mod.getPuzzleByDateD1(db, '2026-04-06')
  assert.equal(result?.date, '2026-04-06')
  assert.equal(result?.difficulty, 'adaptive')
  assert.equal(typeof result?.categories, 'object')
  assert.equal(result?.createdAt, '2026-04-06T00:00:00Z')
  assert.equal(result?.updatedAt, '2026-04-06T00:00:00Z')
})

test('savePuzzleRecord overwrites existing record', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.savePuzzleRecord(db, mkRecord('2026-04-06') as any)
  await mod.savePuzzleRecord(db, { ...mkRecord('2026-04-06'), difficulty: 'hard' } as any)
  const result = await mod.getPuzzleByDateD1(db, '2026-04-06')
  assert.equal(result?.difficulty, 'hard')
})

test('getPuzzleByDateD1 returns null for malformed categories JSON', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  // Manually inject a row with bad JSON
  await db.prepare('INSERT INTO puzzles (date, difficulty, categories, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind('2026-01-01', 'adaptive', 'not-json{{{', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    .run()

  assert.equal(await mod.getPuzzleByDateD1(db, '2026-01-01'), null)
})

// ===========================
// puzzle-db.ts: findNextUnscheduledDate
// ===========================

test('findNextUnscheduledDateD1 returns fromDate when no puzzles exist', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)
  assert.equal(await mod.findNextUnscheduledDateD1(db, '2026-04-06', 30), '2026-04-06')
})

test('findNextUnscheduledDateD1 finds gap in scheduled dates', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  for (const d of ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-10']) {
    await mod.savePuzzleRecord(db, mkRecord(d) as any)
  }

  assert.equal(await mod.findNextUnscheduledDateD1(db, '2026-04-06', 30), '2026-04-09')
})

test('findNextUnscheduledDateD1 returns day after last when no gaps', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  for (const d of ['2026-04-06', '2026-04-07', '2026-04-08']) {
    await mod.savePuzzleRecord(db, mkRecord(d) as any)
  }

  assert.equal(await mod.findNextUnscheduledDateD1(db, '2026-04-06', 30), '2026-04-09')
})

test('findNextUnscheduledDateD1 works with large maxDaysToScan (3650)', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.savePuzzleRecord(db, mkRecord('2026-04-07') as any)
  assert.equal(await mod.findNextUnscheduledDateD1(db, '2026-04-07', 3650), '2026-04-08')
})

test('findNextUnscheduledDateD1 returns null when all days scheduled within scan range', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  for (const d of ['2026-04-06', '2026-04-07', '2026-04-08']) {
    await mod.savePuzzleRecord(db, mkRecord(d) as any)
  }

  assert.equal(await mod.findNextUnscheduledDateD1(db, '2026-04-06', 3), null)
})

test('findNextUnscheduledDateD1 skips dates before fromDate', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  // 04-08 is scheduled, but scan starts from 04-09
  await mod.savePuzzleRecord(db, mkRecord('2026-04-08') as any)
  assert.equal(await mod.findNextUnscheduledDateD1(db, '2026-04-09', 30), '2026-04-09')
})

// ===========================
// puzzle-db.ts: getScheduledDatesInRange
// ===========================

test('getScheduledDatesInRange returns empty for no puzzles', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  const result = await mod.getScheduledDatesInRange(db, '2026-04-01', '2026-04-30')
  assert.deepEqual(result, {})
})

test('getScheduledDatesInRange returns filled categories per date', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.savePuzzleRecord(db, mkRecord('2026-04-06') as any)
  await mod.savePuzzleRecord(db, mkRecord('2026-04-07') as any)

  const result = await mod.getScheduledDatesInRange(db, '2026-04-05', '2026-04-08')
  assert.ok(result['2026-04-06'])
  assert.ok(result['2026-04-07'])
  assert.equal(result['2026-04-05'], undefined)
  assert.equal(result['2026-04-08'], undefined)
  assert.ok(result['2026-04-06'].includes('jigsaw'))
  assert.ok(result['2026-04-06'].includes('diamond'))
})

test('getScheduledDatesInRange filters out categories without imageUrl', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.savePuzzleRecord(db, mkRecord('2026-04-06', {
    jigsaw: { imageUrl: '/cdn/test.jpg' },
    slider: { noImageUrl: true },
  }) as any)

  const result = await mod.getScheduledDatesInRange(db, '2026-04-06', '2026-04-06')
  assert.deepEqual(result['2026-04-06'], ['jigsaw'])
})

// ===========================
// puzzle-db.ts: Prompt history
// ===========================

test('getPromptHistoryD1 returns empty array when no history', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)
  const history = await mod.getPromptHistoryD1(db)
  assert.deepEqual(history, [])
})

test('appendPromptHistory + getPromptHistoryD1 round-trips', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.appendPromptHistory(db, { descriptors: ['foo', 'bar'], createdAt: '2026-04-06T00:00:00Z' })
  await mod.appendPromptHistory(db, { descriptors: ['baz'], createdAt: '2026-04-06T01:00:00Z' })

  const history = await mod.getPromptHistoryD1(db)
  assert.equal(history.length, 2)
  assert.deepEqual(history[0].descriptors, ['foo', 'bar'])
  assert.deepEqual(history[1].descriptors, ['baz'])
})

test('getPromptHistoryD1 returns items in chronological order', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.appendPromptHistory(db, { descriptors: ['first'], createdAt: '2026-04-06T00:00:00Z' })
  await mod.appendPromptHistory(db, { descriptors: ['second'], createdAt: '2026-04-06T01:00:00Z' })
  await mod.appendPromptHistory(db, { descriptors: ['third'], createdAt: '2026-04-06T02:00:00Z' })

  const history = await mod.getPromptHistoryD1(db)
  assert.deepEqual(history[0].descriptors, ['first'])
  assert.deepEqual(history[2].descriptors, ['third'])
})

test('getPromptHistoryD1 skips rows with malformed JSON', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.appendPromptHistory(db, { descriptors: ['good'], createdAt: '2026-04-06T00:00:00Z' })

  // Manually inject a bad row
  await db.prepare('INSERT INTO prompt_history (descriptors, created_at) VALUES (?, ?)')
    .bind('not-json{{{', '2026-04-06T01:00:00Z')
    .run()

  const history = await mod.getPromptHistoryD1(db)
  assert.equal(history.length, 1)
  assert.deepEqual(history[0].descriptors, ['good'])
})

// ===========================
// puzzle-db.ts: Batch jobs
// ===========================

test('getBatchJob returns null when no job exists', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)
  assert.equal(await mod.getBatchJob(db), null)
})

test('saveBatchJob + getBatchJob round-trips', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  const job = {
    batchName: 'test-batch',
    targetDate: '2026-04-10',
    categories: { jigsaw: { theme: 'Test', keywords: ['a'] } } as any,
    submittedAt: '2026-04-06T00:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
  }

  await mod.saveBatchJob(db, job)
  const retrieved = await mod.getBatchJob(db)
  assert.equal(retrieved?.batchName, 'test-batch')
  assert.equal(retrieved?.targetDate, '2026-04-10')
  assert.equal(retrieved?.phase, 'submitted')
  assert.deepEqual(retrieved?.processedCategories, [])
  assert.equal(retrieved?.requestedCategories, undefined)
})

test('saveBatchJob with requestedCategories round-trips', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  const job = {
    batchName: 'single-cat',
    targetDate: '2026-04-10',
    categories: {} as any,
    submittedAt: '2026-04-06T00:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
    requestedCategories: ['jigsaw'] as any[],
  }

  await mod.saveBatchJob(db, job)
  const retrieved = await mod.getBatchJob(db)
  assert.deepEqual(retrieved?.requestedCategories, ['jigsaw'])
})

test('saveBatchJob overwrites existing job for the same target date', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  const job = {
    batchName: 'test-batch',
    targetDate: '2026-04-10',
    categories: {} as any,
    submittedAt: '2026-04-06T00:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
  }

  await mod.saveBatchJob(db, job)
  job.phase = 'fetched'
  job.processedCategories = ['jigsaw' as any]
  await mod.saveBatchJob(db, job)

  const updated = await mod.getBatchJob(db)
  assert.equal(updated?.phase, 'fetched')
  assert.deepEqual(updated?.processedCategories, ['jigsaw'])
})

test('saveBatchJob supports multiple jobs for different dates (queue)', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.saveBatchJob(db, {
    batchName: 'first',
    targetDate: '2026-04-10',
    categories: {} as any,
    submittedAt: '2026-04-06T00:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
  })
  await mod.saveBatchJob(db, {
    batchName: 'second',
    targetDate: '2026-04-11',
    categories: {} as any,
    submittedAt: '2026-04-06T01:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
  })

  const queue = await mod.getAllPendingBatchJobs(db)
  assert.equal(queue.length, 2)
  const dates = queue.map((j) => j.targetDate).sort()
  assert.deepEqual(dates, ['2026-04-10', '2026-04-11'])

  const byDate = await mod.getBatchJobByTargetDate(db, '2026-04-11')
  assert.equal(byDate?.batchName, 'second')
})

test('deleteBatchJob removes a specific job by batch name', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.saveBatchJob(db, {
    batchName: 'keep',
    targetDate: '2026-04-10',
    categories: {} as any,
    submittedAt: '2026-04-06T00:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
  })
  await mod.saveBatchJob(db, {
    batchName: 'drop',
    targetDate: '2026-04-11',
    categories: {} as any,
    submittedAt: '2026-04-06T01:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
  })

  await mod.deleteBatchJob(db, 'drop')
  const remaining = await mod.getAllPendingBatchJobs(db)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.batchName, 'keep')
})

test('multiple single-category jobs can share a target date', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)

  await mod.saveBatchJob(db, {
    batchName: 'jigsaw-redo',
    targetDate: '2026-04-20',
    categories: {} as any,
    submittedAt: '2026-04-06T00:00:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
    requestedCategories: ['jigsaw'] as any[],
  })
  await mod.saveBatchJob(db, {
    batchName: 'diamond-redo',
    targetDate: '2026-04-20',
    categories: {} as any,
    submittedAt: '2026-04-06T00:01:00Z',
    phase: 'submitted' as const,
    processedCategories: [] as any[],
    requestedCategories: ['diamond'] as any[],
  })

  const sameDate = await mod.getBatchJobsByTargetDate(db, '2026-04-20')
  assert.equal(sameDate.length, 2)
  const cats = sameDate.map((j) => j.requestedCategories?.[0]).sort()
  assert.deepEqual(cats, ['diamond', 'jigsaw'])
})

test('deleteBatchJob is safe when no job exists', async () => {
  const mod = await loadPuzzleDb()
  const db = createMockDB()
  await mod.ensurePuzzleTables(db)
  await mod.deleteBatchJob(db, 'missing-batch') // should not throw
})

// ===========================
// puzzles.ts: wrapper functions (ensure they call ensurePuzzleTables)
// ===========================

test('puzzles.getPuzzleByDate calls through to D1', async () => {
  const mod = await loadPuzzles()
  const db = createMockDB()

  assert.equal(await mod.getPuzzleByDate(db, '2026-04-06'), null)

  await mod.savePuzzleRecord(db, mkRecord('2026-04-06') as any)
  const result = await mod.getPuzzleByDate(db, '2026-04-06')
  assert.equal(result?.date, '2026-04-06')
})

test('puzzles.findNextUnscheduledDate calls through to D1', async () => {
  const mod = await loadPuzzles()
  const db = createMockDB()

  assert.equal(await mod.findNextUnscheduledDate(db, '2026-04-06', 30), '2026-04-06')

  await mod.savePuzzleRecord(db, mkRecord('2026-04-06') as any)
  assert.equal(await mod.findNextUnscheduledDate(db, '2026-04-06', 30), '2026-04-07')
})

// ===========================
// prompts.ts: generatePromptPacks
// ===========================

test('generatePromptPacks returns a pack and persists history', async () => {
  const mod = await loadPrompts()
  const { getPromptHistoryD1 } = await loadPuzzleDb()
  const db = createMockDB()

  const packs = await mod.generatePromptPacks(db, 1)
  assert.equal(packs.length, 1)

  const pack = packs[0]
  assert.ok(pack.categories.jigsaw)
  assert.ok(pack.categories.slider)
  assert.ok(pack.categories.swap)
  assert.ok(pack.categories.polygram)
  assert.ok(pack.categories.diamond)

  // Each category should have prompt, theme, keywords
  for (const cat of ['jigsaw', 'slider', 'swap', 'polygram', 'diamond'] as const) {
    assert.ok(pack.categories[cat].prompt.length > 0)
    assert.ok(pack.categories[cat].theme.length > 0)
    assert.ok(pack.categories[cat].keywords.length > 0)
  }

  // History should have been persisted
  const history = await getPromptHistoryD1(db)
  assert.equal(history.length, 1)
  assert.ok(history[0].descriptors.length > 0)
})

test('generatePromptPacks with count > 1 persists all history items', async () => {
  const mod = await loadPrompts()
  const { getPromptHistoryD1 } = await loadPuzzleDb()
  const db = createMockDB()

  const packs = await mod.generatePromptPacks(db, 3)
  assert.equal(packs.length, 3)

  const history = await getPromptHistoryD1(db)
  assert.equal(history.length, 3)
})

// ===========================
// prompts.ts: generateSingleCategoryPrompt
// ===========================

test('generateSingleCategoryPrompt returns prompt details and persists history', async () => {
  const mod = await loadPrompts()
  const { getPromptHistoryD1 } = await loadPuzzleDb()
  const db = createMockDB()

  const result = await mod.generateSingleCategoryPrompt(db, 'jigsaw')
  assert.ok(result.prompt.length > 0)
  assert.ok(result.theme.length > 0)
  assert.ok(result.keywords.length > 0)

  const history = await getPromptHistoryD1(db)
  assert.equal(history.length, 1)
})

test('generateSingleCategoryPrompt works for all categories', async () => {
  const mod = await loadPrompts()
  const db = createMockDB()

  for (const cat of ['jigsaw', 'slider', 'swap', 'polygram', 'diamond'] as const) {
    // Clear module cache each time to reset tablesReady
    const freshMod = await loadPrompts()
    const freshDb = createMockDB()
    const result = await freshMod.generateSingleCategoryPrompt(freshDb, cat)
    assert.ok(result.prompt.length > 0, `${cat} should produce a prompt`)
  }
})
