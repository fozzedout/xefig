import { generatePromptPacks } from '../src/lib/prompts'

const mockDB = {
  prepare: () => ({
    bind: (..._args: unknown[]) => ({
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({}),
    }),
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({}),
  }),
  batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [] })),
} as unknown as D1Database

async function run() {
  const packs = await generatePromptPacks(mockDB, 5)
  console.log(JSON.stringify(packs, null, 2))
}

run().catch(console.error)
