import { createApp } from './app'
import { handleBatchSubmit, handleBatchPoll, getBatchJobStatus } from './lib/scheduled'
import type { Bindings } from './types'

const app = createApp()

async function sendAlert(env: Bindings, subject: string, body: string): Promise<void> {
  const recipient = (env.CONTACT_EMAIL || '').trim()
  if (!recipient || !env.SEND_EMAIL) return

  try {
    const { createMimeMessage } = await import('mimetext')
    const msg = createMimeMessage()
    msg.setSender({ name: 'Xefig Alerts', addr: 'noreply@xefig.com' })
    msg.setRecipient(recipient)
    msg.setSubject(subject)
    msg.addMessage({ contentType: 'text/plain', data: body })
    const { EmailMessage } = await import('cloudflare:email')
    const emailMsg = new EmailMessage('noreply@xefig.com', recipient, msg.asRaw())
    await env.SEND_EMAIL.send(emailMsg)
  } catch (emailErr) {
    console.error('Alert email failed', emailErr)
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    if (event.cron === '0 0 * * *') {
      // Daily: submit new batch job
      try {
        const result = await handleBatchSubmit(env)
        if (!result.submitted) {
          console.warn('Batch submit skipped:', result.message)
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('Batch submit failed', error)
        ctx.waitUntil(sendAlert(env, 'Xefig: Batch submit failed', `The daily batch submit failed.\n\nError: ${msg}\n\nTime: ${new Date().toISOString()}`))
      }
    } else {
      // Hourly: poll and process
      try {
        const result = await handleBatchPoll(env)

        if (result.state === 'failed') {
          ctx.waitUntil(sendAlert(env, `Xefig: Batch failed for ${result.targetDate}`, `Batch job for ${result.targetDate} failed.\n\nError: ${result.error || 'Unknown'}\nBatch: ${result.batchName}\nSubmitted: ${result.submittedAt}`))
        }

        if (result.found && result.savedDate) {
          console.log(`Puzzle saved for ${result.savedDate}`)
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('Batch poll failed', error)
        ctx.waitUntil(sendAlert(env, 'Xefig: Batch processing error', `The hourly batch poll/processing failed.\n\nError: ${msg}\n\nTime: ${new Date().toISOString()}`))
      }

      // Check for stuck jobs (submitted > 24h ago, still not done)
      try {
        const status = await getBatchJobStatus(env)
        if (status.active && status.submittedAt) {
          const ageMs = Date.now() - new Date(status.submittedAt).getTime()
          const ageHours = ageMs / (1000 * 60 * 60)
          if (ageHours > 24) {
            ctx.waitUntil(sendAlert(env, `Xefig: Batch stuck for ${status.targetDate}`, `Batch job has been active for ${Math.round(ageHours)}h without completing.\n\nTarget: ${status.targetDate}\nPhase: ${status.phase}\nBatch: ${status.batchName}\nSubmitted: ${status.submittedAt}\nProcessed: ${(status.processedCategories || []).join(', ') || 'none'}\nRemaining: ${(status.remainingCategories || []).join(', ') || 'none'}`))
          }
        }
      } catch {
        // Non-fatal
      }
    }
  },
} satisfies ExportedHandler<Bindings>
