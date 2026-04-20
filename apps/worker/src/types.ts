export type Bindings = {
  assets: R2Bucket
  DB: D1Database
  AI: Ai
  STATIC_ASSETS: Fetcher
  SEND_EMAIL: { send: (message: unknown) => Promise<void> }
  ADMIN_PASSWORD?: string
  ADMIN_SESSION_SECRET?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
  GOOGLE_AI_API_KEY?: string
  GOOGLE_AI_FREE_API_KEY?: string
  GEMMA_REWRITE_MODEL?: string
  CONTACT_EMAIL?: string
  // Beta-environment flags. When IS_BETA is set, the puzzle-content
  // endpoints proxy reads to UPSTREAM_PUZZLE_ORIGIN (live) so beta
  // doesn't need to generate its own puzzles — only player progress
  // and leaderboard writes hit beta's own D1.
  IS_BETA?: string
  UPSTREAM_PUZZLE_ORIGIN?: string
}

export const CATEGORIES = ['jigsaw', 'slider', 'swap', 'polygram', 'diamond'] as const
export type PuzzleCategory = (typeof CATEGORIES)[number]
export type FormValue = string | File | Array<string | File>

export const LEADERBOARD_GAME_MODES = ['jigsaw', 'sliding', 'swap', 'polygram', 'diamond'] as const
export type LeaderboardGameMode = (typeof LEADERBOARD_GAME_MODES)[number]

export type PuzzleAsset = {
  imageKey: string
  imageUrl: string
  contentType: string
  fileName: string
  theme: string
  tags: string[]
  thumbnailKey?: string
  thumbnailUrl?: string
}

export type PuzzleRecord = {
  date: string
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
  categories: Record<
    PuzzleCategory,
    {
      prompt: string
      theme: string
      keywords: string[]
    }
  >
}
