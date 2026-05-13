import test from 'node:test'
import assert from 'node:assert/strict'

test('diamond pack picks accents and adds Details line', async () => {
  const rows: { id: number; descriptors: string; created_at: string }[] = []
  let nextId = 1
  const mkStmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      async run() {
        if (sql.includes('INSERT INTO prompt_history')) {
          rows.push({ id: nextId++, descriptors: args[0] as string, created_at: args[1] as string })
        }
        return { success: true }
      },
      async first() { return null },
      async all() {
        if (sql.includes('SELECT descriptors')) {
          return { results: [...rows].reverse().map(r => ({ descriptors: r.descriptors, created_at: r.created_at })) }
        }
        return { results: [] }
      },
    }),
  }) as unknown as D1PreparedStatement

  const db = {
    prepare: (sql: string) => mkStmt(sql),
    batch: async (xs: unknown[]) => xs.map(() => ({ success: true })),
  } as unknown as D1Database

  delete require.cache[require.resolve('../src/lib/puzzle-db')]
  delete require.cache[require.resolve('../src/lib/prompts')]
  const mod = await import('../src/lib/prompts')

  const packs = await mod.generatePromptPacks(db, 2)
  assert.equal(packs.length, 2)

  for (const pack of packs) {
    const diamondDesc = pack.categories.diamond.descriptive
    assert.match(diamondDesc, /Details:/, 'diamond descriptive should contain Details line')
    const detailsLine = diamondDesc.split('\n').find(l => l.startsWith('Details:'))!
    const accents = detailsLine.replace('Details: ', '').split(', ')
    assert.equal(accents.length, 4, 'should have 4 accents')

    // Non-diamond categories should NOT have a Details line
    for (const cat of ['jigsaw', 'slider', 'swap', 'polygram'] as const) {
      assert.doesNotMatch(pack.categories[cat].descriptive, /Details:/, `${cat} should NOT have Details line`)
    }
  }

  // Pack-to-pack accent variation: at least one accent should differ
  const accents1 = packs[0].categories.diamond.descriptive.split('\n').find(l => l.startsWith('Details:'))!
  const accents2 = packs[1].categories.diamond.descriptive.split('\n').find(l => l.startsWith('Details:'))!
  assert.notEqual(accents1, accents2, 'two consecutive packs should pick different accent bags')

  // History row contains the accents (so LRU rotation works)
  const lastRow = JSON.parse(rows[rows.length - 1].descriptors) as string[]
  assert.ok(lastRow.length >= 7, `history descriptors should include role values + accents, got ${lastRow.length}`)
})
