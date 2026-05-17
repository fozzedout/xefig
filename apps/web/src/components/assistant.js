// Shared in-game helper used by every puzzle mode. Replaces the floating ⋯
// kebab button with the brand rosette. Tapping it opens the same menu the
// kebab opened, but the menu also exposes "How to play" and "I need a hint!"
// — both run a guided sequence where a copy of the rosette ("the bouncer")
// traverses the screen, pausing over UI elements with a speech bubble.
//
// On entering a mode the assistant auto-nudges (bouncing in place + bubble)
// if the player is new to that mode or hasn't touched it in >14 days. The
// nudge is dismissable per-session via the bubble's X.

const LAST_PLAYED_KEY_PREFIX = 'xefig:assistant:lastPlayed:'
const NUDGE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000

export const ASSISTANT_LOGO_SVG = `
<svg class="assistant-logo" viewBox="0 0 200 200" aria-hidden="true">
  <g transform="translate(100 100) rotate(-20)">
    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#e070a0"/>
    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#40d0f0" transform="rotate(72)"/>
    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#a060f0" transform="rotate(144)"/>
    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#f0c040" transform="rotate(216)"/>
    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#50d070" transform="rotate(288)"/>
  </g>
</svg>
`

export function shouldNudge(mode) {
  try {
    const raw = localStorage.getItem(LAST_PLAYED_KEY_PREFIX + mode)
    if (!raw) return true
    const last = parseInt(raw, 10)
    if (!Number.isFinite(last)) return true
    return (Date.now() - last) > NUDGE_THRESHOLD_MS
  } catch {
    return false
  }
}

export function recordPlayed(mode) {
  try {
    localStorage.setItem(LAST_PLAYED_KEY_PREFIX + mode, String(Date.now()))
  } catch {
    // localStorage may be blocked (private mode, quota); skip silently
  }
}

export class GameAssistant {
  constructor({ button, menu, workspace, mode } = {}) {
    if (!button || !menu || !workspace) {
      throw new Error('GameAssistant requires button, menu, and workspace elements.')
    }
    this.button = button
    this.menu = menu
    this.workspace = workspace
    this.mode = mode || ''

    this.bubble = null
    this.bouncer = null
    this.sequenceCancelled = false
    this.sequenceTimer = null
    this.nudgeDismissed = false
    this.repositionRaf = null
    this.handleResize = () => this.repositionBubble()
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('orientationchange', this.handleResize)
  }

  // Bounce in place + speech bubble. The bubble has an X that dismisses for
  // the session — after that, tapping the button just opens the menu like
  // a normal ⋯ would.
  // Track whether the helper is currently demanding the player's attention.
  // While true, the workspace tags itself .workspace--helper-active so the
  // immersive chrome doesn't auto-dim out from under the helper UI.
  _syncHelperActive() {
    const active = Boolean(
      this.bouncer
      || this.tutorialBubble
      || this.bubble
      || this.button.classList.contains('assistant-btn--bouncing'),
    )
    this.workspace.classList.toggle('workspace--helper-active', active)
  }

  showNudge(message = 'Need some help?') {
    if (this.nudgeDismissed) return
    this.dismissBubble()
    this.button.classList.add('assistant-btn--bouncing')

    const bubble = document.createElement('div')
    bubble.className = 'assistant-bubble assistant-bubble--anchor'
    bubble.innerHTML = `
      <button type="button" class="assistant-bubble-close" aria-label="Dismiss helper">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>
      </button>
      <span class="assistant-bubble-text"></span>
    `
    bubble.querySelector('.assistant-bubble-text').textContent = message
    this.workspace.append(bubble)
    this.bubble = bubble
    this._syncHelperActive()

    this.repositionBubble()

    bubble.addEventListener('click', (event) => {
      // Always stop propagation: the document-level outside-click listener
      // closes the menu whenever a click bubbles up to it, which would
      // immediately cancel the menu we just opened below.
      event.stopPropagation()
      if (event.target.closest('.assistant-bubble-close')) {
        this.nudgeDismissed = true
        this.dismissNudge()
        return
      }
      // Tap anywhere else on the bubble = "yes, help me" → open the menu.
      this.dismissNudge()
      this.openMenu()
    })
  }

  dismissNudge() {
    this.button.classList.remove('assistant-btn--bouncing')
    this.dismissBubble()
    this._syncHelperActive()
  }

  dismissBubble() {
    if (this.bubble) {
      this.bubble.remove()
      this.bubble = null
    }
  }

  repositionBubble() {
    if (!this.bubble) return
    // Layout-on-next-frame so the bubble has measured itself.
    if (this.repositionRaf) cancelAnimationFrame(this.repositionRaf)
    this.repositionRaf = requestAnimationFrame(() => {
      this.repositionRaf = null
      if (!this.bubble) return
      const btnRect = this.button.getBoundingClientRect()
      const wsRect = this.workspace.getBoundingClientRect()
      const bubbleRect = this.bubble.getBoundingClientRect()
      // Preferred placement: to the left of the button, vertically
      // centred on it. If the button is hard against the left edge of
      // the workspace (e.g. polygram landscape, jigsaw landscape) the
      // bubble would have to clamp into the button's footprint and
      // its opaque background would hide the rosette. In that case,
      // flip above the button instead. Falls back to below if even
      // that doesn't fit (very short workspaces).
      const leftPlacement = (btnRect.left - wsRect.left) - bubbleRect.width - 12
      let left
      let top
      if (leftPlacement >= 8) {
        left = leftPlacement
        top = (btnRect.top - wsRect.top) + (btnRect.height / 2) - (bubbleRect.height / 2)
        if (top < 8) top = 8
        const maxTop = wsRect.height - bubbleRect.height - 8
        if (top > maxTop) top = maxTop
      } else {
        // Horizontally centre on the button, vertically place above.
        left = (btnRect.left - wsRect.left) + (btnRect.width / 2) - (bubbleRect.width / 2)
        if (left < 8) left = 8
        const maxLeft = wsRect.width - bubbleRect.width - 8
        if (left > maxLeft) left = maxLeft
        top = (btnRect.top - wsRect.top) - bubbleRect.height - 12
        if (top < 8) {
          // No room above either — fall through to below the button.
          top = (btnRect.bottom - wsRect.top) + 12
        }
      }
      this.bubble.style.transform = `translate(${left}px, ${top}px)`
    })
  }

  openMenu() {
    if (!this.menu || !this.button) return
    this.menu.hidden = false
    this.button.setAttribute('aria-expanded', 'true')
  }

  closeMenu() {
    if (!this.menu || !this.button) return
    this.menu.hidden = true
    this.button.setAttribute('aria-expanded', 'false')
  }

  // Run a sequence of guided steps. Each step is:
  //   {
  //     target: Element | selector | rect | null,
  //     message: string,
  //     advanceOn?: { element: Element, event: string }[],   // auto-advance
  //     onShow?: (assistant) => undefined | (() => void)     // side-effect
  //                                                          // demo; may
  //                                                          // return a
  //                                                          // cleanup fn
  //                                                          // (called when
  //                                                          // the step
  //                                                          // ends or the
  //                                                          // sequence is
  //                                                          // cancelled).
  //   }
  // `target` null = bouncer stays put (intro/outro). The player advances
  // by tapping anywhere on the bubble (not the X) — or automatically when
  // any of the `advanceOn` events fires (e.g. picking up the right piece).
  async runSequence(steps) {
    this.cancelSequence()
    this.closeMenu()
    this.dismissNudge()
    this.sequenceCancelled = false

    const bouncer = document.createElement('div')
    bouncer.className = 'assistant-bouncer'
    bouncer.innerHTML = `<div class="assistant-bouncer-mark">${ASSISTANT_LOGO_SVG}</div>`
    this.workspace.append(bouncer)
    this.bouncer = bouncer

    // Speech bubble attached to the rosette (positioned by JS each time the
    // bouncer moves). Tap anywhere on it to advance; tap the X to bail.
    // The footer carries either a 'Next ›' chip (manual-advance steps) or
    // an action-hint line (steps waiting on a specific gesture) so the
    // affordance is always explicit — testers couldn't tell the bubble
    // body itself was tappable.
    const bubble = document.createElement('div')
    bubble.className = 'assistant-tutorial-bubble'
    bubble.innerHTML = `
      <button type="button" class="assistant-tutorial-bubble-close" aria-label="Close helper">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>
      </button>
      <span class="assistant-tutorial-bubble-text"></span>
      <div class="assistant-tutorial-bubble-footer">
        <span class="assistant-tutorial-bubble-action"></span>
        <button type="button" class="assistant-tutorial-bubble-next" aria-label="Next">
          <span class="assistant-tutorial-bubble-next-label">Next</span>
          <span class="assistant-tutorial-bubble-next-chevron" aria-hidden="true">›</span>
        </button>
      </div>
    `
    this.workspace.append(bubble)
    this.tutorialBubble = bubble
    this._syncHelperActive()

    const textEl = bubble.querySelector('.assistant-tutorial-bubble-text')

    bubble.addEventListener('click', (event) => {
      event.stopPropagation()
      if (event.target.closest('.assistant-tutorial-bubble-close')) {
        this.cancelSequence()
        return
      }
      // For steps waiting on a specific in-game gesture, a bubble tap
      // collapses it out of the way (the bouncer becomes clickable to
      // bring it back) instead of advancing — players asked for this
      // because the bubble sits over the puzzle area during long
      // action steps and gets in the way.
      if (this.currentStep?.collapseOnInteraction) {
        this._collapseTutorialBubble()
        return
      }
      // Other noManualAdvance steps (e.g. polygram rotate) keep the
      // bubble visible — a bubble tap there is a no-op rather than a
      // hide, since hiding would defeat the guidance.
      if (this.currentStep?.noManualAdvance) return
      if (this.sequenceAdvanceResolve) this.sequenceAdvanceResolve(true)
    })

    // Tap on the bouncer to re-summon the bubble after it was collapsed.
    // The bouncer is pointer-events: none by default (so tile/piece taps
    // pass through during normal action steps); we toggle it interactive
    // only while the bubble is collapsed.
    bouncer.addEventListener('click', (event) => {
      event.stopPropagation()
      this._expandTutorialBubble()
    })

    // Workspace-level pointerdown auto-collapses the bubble whenever the
    // player starts interacting with the puzzle during a noManualAdvance
    // step. Ignores taps inside the bubble or on the bouncer so those
    // controls keep working.
    //
    // The collapse is deferred ~300ms: if the same pointerdown ends up
    // being the gesture that advances the step (e.g. the slide that
    // lands tile N home), the new step starts expanded anyway, and an
    // immediate collapse here causes a visible flicker — collapse then
    // expand within the same tick. The step-snapshot check below skips
    // the collapse when the step has switched in the meantime.
    const onWorkspacePointerDown = (event) => {
      // Opt-in per step: noManualAdvance alone isn't enough — some
      // steps (e.g. polygram's "rotate the ring") are slow exploratory
      // gestures where the player needs the bubble visible the whole
      // time. Only the slider's long-action steps opt in.
      if (!this.currentStep?.collapseOnInteraction) return
      if (!this.tutorialBubble) return
      if (this.tutorialBubble.classList.contains('assistant-tutorial-bubble--collapsed')) return
      const t = event.target
      if (t && t.closest && t.closest('.assistant-tutorial-bubble, .assistant-bouncer')) return
      const stepAtSchedule = this.currentStep
      // Track the pending collapse so we can cancel it on step
      // transition. Without this, the slider's "Nice work" pep-talk
      // (which immediately follows a collapseOnInteraction placement
      // step) could be silently collapsed by a stale timer firing
      // moments after the step changed — the bail check inside the
      // timer doesn't reliably win every race, and the user perceives
      // the final bubble as auto-closing.
      if (this._pendingCollapseTimer) clearTimeout(this._pendingCollapseTimer)
      this._pendingCollapseTimer = setTimeout(() => {
        this._pendingCollapseTimer = null
        if (this.currentStep !== stepAtSchedule) return
        if (!this.tutorialBubble) return
        if (this.tutorialBubble.classList.contains('assistant-tutorial-bubble--collapsed')) return
        this._collapseTutorialBubble()
      }, 300)
    }
    this.workspace.addEventListener('pointerdown', onWorkspacePointerDown, true)
    this._sequenceWorkspaceListener = onWorkspacePointerDown

    this.placeBouncerOver(this.button, { instant: true })

    for (let i = 0; i < steps.length; i += 1) {
      if (this.sequenceCancelled || !this.bouncer) break
      const step = steps[i]
      // Exposed so the bubble click handler can check per-step flags
      // (currently: noManualAdvance — blocks tap-to-advance when the
      // sequence is waiting on a specific in-game gesture).
      // Cancel any deferred collapse from the previous step before
      // installing the new one — otherwise a still-pending timer from
      // a collapseOnInteraction step (e.g. slider placement) could
      // fire after this point and quietly hide the new step's bubble.
      if (this._pendingCollapseTimer) {
        clearTimeout(this._pendingCollapseTimer)
        this._pendingCollapseTimer = null
      }
      this.currentStep = step
      textEl.textContent = step.message || ''
      this._updateAdvanceAffordance(step)
      // A target can be a thunk so the picker runs at step-show time —
      // useful when the right pointee depends on live puzzle state
      // (e.g. a tile reachable from the *current* gap, not the gap as
      // it was when the sequence started). Re-evaluating the thunk on
      // expand-from-collapsed also lets the bouncer follow a target
      // that moved while the bubble was hidden.
      this._stepTargetResolver = () => {
        let t = step.target
        if (typeof t === 'function') {
          try { t = t() } catch { t = null }
        }
        return t || null
      }
      const resolvedTarget = this._stepTargetResolver()
      // New step always starts expanded — the previous step may have
      // ended in a collapsed state, and we want the player to see the
      // new message rather than discover it only by tapping the rosette.
      this._expandTutorialBubble()
      if (resolvedTarget) this.placeBouncerOver(resolvedTarget)
      this.positionTutorialBubble()
      if (typeof step.onShow === 'function') {
        try {
          const result = step.onShow(this)
          if (typeof result === 'function') this.currentStepCleanup = result
        } catch {
          // onShow side-effect must never block sequence progression
        }
      }
      const advanced = await this.waitForAdvance(step.advanceOn)
      this._runStepCleanup()
      if (!advanced) break
    }

    // Send-off animation: only when the sequence ran to completion (not
    // when the user cancelled mid-stream — in that case snap dismiss
    // is fine). Dismiss the tutorial bubble first so it doesn't sit
    // there while the rosette flies; then move the bouncer back over
    // the menu button (uses the existing 620ms transform transition);
    // then shrink the inner mark in place; then tear everything down.
    if (!this.sequenceCancelled && this.bouncer && this.button) {
      if (this.tutorialBubble) {
        this.tutorialBubble.classList.add('assistant-tutorial-bubble--leaving')
        const removing = this.tutorialBubble
        this.tutorialBubble = null
        setTimeout(() => removing.remove(), 220)
      }
      this.placeBouncerOver(this.button)
      await this.wait(560)
      if (this.bouncer) this.bouncer.classList.add('assistant-bouncer--shrinking')
      await this.wait(320)
    }

    this.currentStep = null
    this.cancelSequence()
  }

  isBubbleCollapsed() {
    return Boolean(this.tutorialBubble?.classList.contains('assistant-tutorial-bubble--collapsed'))
  }

  // Show the right footer affordance for the current step: a 'Next ›' chip
  // when the bubble itself advances on tap, or an action hint describing
  // the gesture the player needs to perform when it doesn't. Steps can
  // override the auto-derived hint via step.actionHint.
  _updateAdvanceAffordance(step) {
    if (!this.tutorialBubble) return
    const nextBtn = this.tutorialBubble.querySelector('.assistant-tutorial-bubble-next')
    const actionEl = this.tutorialBubble.querySelector('.assistant-tutorial-bubble-action')
    if (!nextBtn || !actionEl) return
    const isActionStep = Boolean(step?.noManualAdvance)
    const isCollapseStep = Boolean(step?.collapseOnInteraction)
    if (isActionStep || isCollapseStep) {
      nextBtn.hidden = true
      const hint = step?.actionHint
        || (isCollapseStep ? 'Tap bubble to hide' : 'Do the gesture above to continue')
      actionEl.textContent = hint
      actionEl.hidden = false
    } else {
      actionEl.hidden = true
      actionEl.textContent = ''
      nextBtn.hidden = false
    }
  }

  _collapseTutorialBubble() {
    if (!this.tutorialBubble) return
    if (this.tutorialBubble.classList.contains('assistant-tutorial-bubble--collapsed')) return
    this.tutorialBubble.classList.add('assistant-tutorial-bubble--collapsed')
    // Bouncer becomes the "tap to bring back the helper" affordance
    // while the bubble is hidden, and we park it on the menu button so
    // it stops blocking taps on whichever tile/piece the step is
    // pointing at. Without this, even with the highlight class added
    // the bouncer would sit on top of the target tile and intercept
    // every tap the player made trying to slide it.
    if (this.bouncer) this.bouncer.classList.add('assistant-bouncer--clickable')
    if (this.button) this.placeBouncerOver(this.button)
  }

  _expandTutorialBubble() {
    if (!this.tutorialBubble) return
    if (!this.tutorialBubble.classList.contains('assistant-tutorial-bubble--collapsed')) return
    this.tutorialBubble.classList.remove('assistant-tutorial-bubble--collapsed')
    if (this.bouncer) this.bouncer.classList.remove('assistant-bouncer--clickable')
    // Re-resolve the current step's target so the bouncer can fly back
    // to whichever tile/element it was pointing at — the player may
    // have moved the target while the bubble was hidden.
    const target = this._stepTargetResolver ? this._stepTargetResolver() : null
    if (target) this.placeBouncerOver(target)
    this.positionTutorialBubble()
  }

  _runStepCleanup() {
    if (typeof this.currentStepCleanup === 'function') {
      try { this.currentStepCleanup() } catch {}
    }
    this.currentStepCleanup = null
  }

  // Resolves true when the user advances (bubble tap or advanceOn event),
  // false when the sequence is cancelled. Auto-cleans whichever listener
  // didn't fire so we never leak a handler onto a piece DOM element.
  waitForAdvance(advanceOn) {
    return new Promise((resolve) => {
      const autoListeners = []
      const cleanup = () => {
        this.sequenceAdvanceResolve = null
        this.sequenceAdvanceReject = null
        for (const { element, event, handler } of autoListeners) {
          element.removeEventListener(event, handler, true)
        }
      }
      this.sequenceAdvanceResolve = (val) => {
        cleanup()
        resolve(val)
      }
      this.sequenceAdvanceReject = () => {
        cleanup()
        resolve(false)
      }
      if (Array.isArray(advanceOn)) {
        for (const trigger of advanceOn) {
          if (!trigger?.element || !trigger?.event) continue
          const handler = (event) => {
            // Optional predicate lets a step demand more than "any
            // event of this name" (e.g. a slide of length > 1).
            if (typeof trigger.predicate === 'function') {
              try {
                if (!trigger.predicate(event)) return
              } catch {
                return
              }
            }
            if (this.sequenceAdvanceResolve) this.sequenceAdvanceResolve(true)
          }
          // Capture-phase so the puzzle's own pointer handlers can't swallow it.
          trigger.element.addEventListener(trigger.event, handler, true)
          autoListeners.push({ element: trigger.element, event: trigger.event, handler })
        }
      }
    })
  }

  cancelSequence() {
    this.sequenceCancelled = true
    this._runStepCleanup()
    if (this._pendingCollapseTimer) {
      clearTimeout(this._pendingCollapseTimer)
      this._pendingCollapseTimer = null
    }
    if (this._sequenceWorkspaceListener) {
      this.workspace.removeEventListener('pointerdown', this._sequenceWorkspaceListener, true)
      this._sequenceWorkspaceListener = null
    }
    // Unblock any awaiting waitForNext so the runSequence loop can exit.
    if (this.sequenceAdvanceReject) {
      this.sequenceAdvanceReject()
      this.sequenceAdvanceReject = null
    }
    if (this.bouncer) {
      // The send-off (runSequence's natural end) shrinks-and-fades
      // the inner mark to scale 0 + opacity 0 first, then calls into
      // cancelSequence. In that case the bouncer is already invisible
      // — running the --leaving opacity fade on top would leave the
      // menu button hidden for an extra 280ms, which reads as the
      // helper "dropping off the screen then reappearing as the
      // button." Detect the shrunk state and remove immediately so
      // the static menu button takes over instantly.
      if (this.bouncer.classList.contains('assistant-bouncer--shrinking')) {
        this.bouncer.remove()
      } else {
        this.bouncer.classList.add('assistant-bouncer--leaving')
        const removingBouncer = this.bouncer
        setTimeout(() => removingBouncer.remove(), 280)
      }
      this.bouncer = null
    }
    if (this.tutorialBubble) {
      this.tutorialBubble.classList.add('assistant-tutorial-bubble--leaving')
      const removing = this.tutorialBubble
      setTimeout(() => removing.remove(), 220)
      this.tutorialBubble = null
    }
    if (this.sequenceTimer) {
      clearTimeout(this.sequenceTimer)
      this.sequenceTimer = null
    }
    if (this.pointedEl) {
      this.pointedEl.classList.remove('is-assistant-target')
      this.pointedEl = null
    }
    this.lastBouncerCentre = null
    this.currentStep = null
    this._syncHelperActive()
  }

  placeBouncerOver(target, { instant = false } = {}) {
    if (!this.bouncer) return
    // If the target lives inside an overflow-scroll container (e.g. the
    // jigsaw carousel), scroll it into view so the bouncer doesn't land
    // on coordinates that are clipped out of view.
    if (target instanceof Element) {
      try {
        target.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' })
      } catch {
        // Older browsers / non-scrollable parents: best-effort, skip.
      }
    }
    // Move the spotlight glow. We tag whichever DOM element the bouncer
    // is currently pointing at so the player has two cues to follow —
    // the rosette's motion and a steady highlight on the target itself.
    if (this.pointedEl && this.pointedEl !== target) {
      this.pointedEl.classList.remove('is-assistant-target')
      this.pointedEl = null
    }
    if (target instanceof Element) {
      target.classList.add('is-assistant-target')
      this.pointedEl = target
    }
    const rect = this.resolveTargetRect(target)
    if (!rect) return
    const wsRect = this.workspace.getBoundingClientRect()
    // The bouncer container is 60×60 anchored top-left at the transform
    // coordinate. We want its *centre* on the target's centre, so we shift
    // the translate back by half the bouncer's size. The clamps then keep
    // the centre at least half-size away from each workspace edge.
    const halfSize = 30
    const targetCx = rect.left - wsRect.left + rect.width / 2
    const targetCy = rect.top - wsRect.top + rect.height / 2
    let centreX = targetCx
    let centreY = targetCy
    // Edge nudge — let the bouncer pull as close as possible to the
    // workspace edge even if part of the rosette clips into the safe-area.
    // Targets like a corner piece on the board, or the menu button in the
    // top-right corner, both legitimately sit at the edge; a hard clamp
    // would offset the alignment and lose the spatial cue. The bouncer
    // does need to stay at least mostly visible, so allow up to half its
    // body to clip past each edge.
    const minVisible = 16
    centreX = Math.min(Math.max(centreX, minVisible), wsRect.width - minVisible)
    centreY = Math.min(Math.max(centreY, minVisible), wsRect.height - minVisible)
    if (instant) this.bouncer.classList.add('assistant-bouncer--instant')
    // Translate so the bouncer's centre (not its top-left) lands at
    // (centreX, centreY). Direct style.transform interpolates cleanly.
    this.bouncer.style.transform = `translate(${centreX - halfSize}px, ${centreY - halfSize}px)`
    // Remember the *destination* (not the current rect) so the bubble can
    // anchor to where the bouncer is heading — measuring getBoundingClientRect
    // mid-transition would give the in-flight position and the bubble would
    // stay frozen at that point while the bouncer continued.
    this.lastBouncerCentre = { x: centreX, y: centreY }
    if (instant) {
      // Drop the instant flag after the next frame so subsequent moves animate.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this.bouncer) this.bouncer.classList.remove('assistant-bouncer--instant')
      }))
    }
    if (this.tutorialBubble) {
      if (instant) this.tutorialBubble.classList.add('assistant-tutorial-bubble--instant')
      this.positionTutorialBubble()
      if (instant) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (this.tutorialBubble) this.tutorialBubble.classList.remove('assistant-tutorial-bubble--instant')
        }))
      }
    }
  }

  // Place the tutorial speech bubble so it reads as a callout from the
  // bouncer. Anchored to the bouncer's *destination* (lastBouncerCentre)
  // so the bubble doesn't snap to the bouncer's mid-transition position
  // and lose track of where it's going. CSS gives the bubble the same
  // ease/duration as the bouncer so they travel together.
  positionTutorialBubble() {
    if (!this.tutorialBubble || !this.lastBouncerCentre) return
    const wsRect = this.workspace.getBoundingClientRect()
    const bubble = this.tutorialBubble
    // Force a layout read so the bubble's actual height is up-to-date
    // (the text content may have just changed this tick).
    const bubbleHeight = bubble.offsetHeight || 80
    const bubbleWidth = bubble.offsetWidth || 280
    const bcx = this.lastBouncerCentre.x
    const bcy = this.lastBouncerCentre.y
    const gap = 18
    const halfBouncer = 30
    const margin = 12

    // Pick vertical side. Prefer below; fall back to above when below
    // doesn't fit.
    const spaceBelow = wsRect.height - (bcy + halfBouncer) - margin
    const spaceAbove = (bcy - halfBouncer) - margin
    let anchor
    let top
    if (spaceBelow >= bubbleHeight + gap) {
      anchor = 'top'  // arrow on bubble's TOP edge points up at bouncer above
      top = bcy + halfBouncer + gap
    } else if (spaceAbove >= bubbleHeight + gap) {
      anchor = 'bottom'
      top = bcy - halfBouncer - gap - bubbleHeight
    } else {
      anchor = 'top'
      top = bcy + halfBouncer + gap
    }
    top = Math.max(margin, Math.min(top, wsRect.height - bubbleHeight - margin))

    // Horizontal placement: centre under/above the bouncer, then clamp to
    // workspace. Compute the arrow's X offset so the tail keeps pointing
    // at the bouncer even when the bubble's been shoved sideways by the
    // clamp.
    let left = bcx - bubbleWidth / 2
    left = Math.max(margin, Math.min(left, wsRect.width - bubbleWidth - margin))
    const arrowX = Math.max(18, Math.min(bcx - left, bubbleWidth - 18))

    bubble.setAttribute('data-anchor', anchor)
    bubble.style.setProperty('--arrow-x', `${arrowX}px`)
    bubble.style.transform = `translate(${left}px, ${top}px)`
  }

  resolveTargetRect(target) {
    if (!target) return null
    if (typeof target === 'string') {
      const el = document.querySelector(target)
      return el ? el.getBoundingClientRect() : null
    }
    if (target instanceof Element) return target.getBoundingClientRect()
    if (typeof target.left === 'number' && typeof target.top === 'number') return target
    return null
  }

  wait(ms) {
    return new Promise((resolve) => {
      this.sequenceTimer = setTimeout(() => {
        this.sequenceTimer = null
        resolve()
      }, ms)
    })
  }

  destroy() {
    this.dismissNudge()
    this.cancelSequence()
    window.removeEventListener('resize', this.handleResize)
    window.removeEventListener('orientationchange', this.handleResize)
  }
}
