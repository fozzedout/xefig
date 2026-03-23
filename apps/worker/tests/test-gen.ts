import { generatePromptPacks } from '../src/lib/prompts'

const mockKV = {
  get: async () => null,
  put: async () => {},
  delete: async () => {},
  list: async () => ({ keys: [], list_complete: true }),
} as unknown as KVNamespace

async function run() {
  const packs = await generatePromptPacks(mockKV, 5)
  console.log(JSON.stringify(packs, null, 2))
}

run().catch(console.error)
