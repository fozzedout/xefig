export type Bindings = {
  assets: R2Bucket
  metadata: KVNamespace
  DB: D1Database
  STATIC_ASSETS: Fetcher
  ADMIN_PASSWORD?: string
}

export const CATEGORIES = ['jigsaw', 'slider', 'swap', 'polygram'] as const
export type PuzzleCategory = (typeof CATEGORIES)[number]
export type FormValue = string | File | Array<string | File>

export const LEADERBOARD_DIFFICULTIES = ['easy', 'medium', 'hard', 'extreme'] as const
export type LeaderboardDifficulty = (typeof LEADERBOARD_DIFFICULTIES)[number]

export const LEADERBOARD_GAME_MODES = ['jigsaw', 'sliding', 'swap', 'polygram'] as const
export type LeaderboardGameMode = (typeof LEADERBOARD_GAME_MODES)[number]

export type PuzzleAsset = {
  imageKey: string
  imageUrl: string
  contentType: string
  fileName: string
}

export type PuzzleRecord = {
  date: string
  theme: string
  tags: string[]
  difficulty: string
  categories: Record<PuzzleCategory, PuzzleAsset>
  createdAt: string
  updatedAt: string
}

export type PromptHistoryItem = {
  descriptors: string[]
  createdAt: string
}

export type PromptPack = {
  themeName: string
  keywords: string[]
  prompts: Record<PuzzleCategory, string>
}
