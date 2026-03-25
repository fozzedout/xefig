import { createApp } from './app'
import { handleBatchSubmit, handleBatchPoll } from './lib/scheduled'
import type { Bindings } from './types'

const app = createApp()

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    if (event.cron === '0 0 * * *') {
      ctx.waitUntil(handleBatchSubmit(env))
    } else {
      ctx.waitUntil(handleBatchPoll(env))
    }
  },
} satisfies ExportedHandler<Bindings>
