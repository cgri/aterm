import type { PlanStartMode } from '@shared/types'
import { renderPlan } from './planMarkdown'

/** A comment on a passage, anchored by character offsets into the plan's text. */
export interface PlanComment {
  start: number
  end: number
  /** The passage as it read when the comment was made — what Claude is shown. */
  quote: string
  text: string
}

/** What a round of review leaves behind: sent back to Claude, or put aside for later. */
export interface PlanRound {
  /** What was reviewed — in a text review, the user's own edit of it, if they made one. */
  plan: string
  /** A text review: the text as Claude handed it over, before that edit. */
  original?: string
  comments: PlanComment[]
  general: string
  round: number
}

export interface PlanReviewHandlers {
  /** `notes` are the comments, written up to be appended to the plan. */
  approve(mode: PlanStartMode, notes?: string): void
  revise(feedback: string, round: PlanRound): void
  /** Esc: no decision, the terminal asks. What was written so far is handed back. */
  pass(draft: PlanRound): void
}

/**
 * A text Claude means to post somewhere on the user's behalf — a PR description, a
 * comment, a ticket — held by the `review_text` tool until the user decides here.
 */
export interface TextReviewHandlers {
  /** `text` is what is to be posted, word for word; `edited` says the user changed it. */
  approve(text: string, edited: boolean): void
  revise(feedback: string, round: PlanRound): void
  /** Not to be posted at all. `reason` is the general comment, if one was written. */
  reject(reason?: string): void
  pass(draft: PlanRound): void
}

/** What the panel reviews: a plan, through the ExitPlanMode hook, or a text, through MCP. */
export type ReviewMode =
  | { kind: 'plan'; handlers: PlanReviewHandlers }
  | { kind: 'text'; handlers: TextReviewHandlers }

/** What a text review shows in its head: what the text is, and where it is going. */
export interface TextHeading {
  title: string
  target: string
}

/**
 * The comment marks. One registry for the whole document, so both highlights are shared
 * by every pane; each review adds and removes only its own ranges. The CSS Custom
 * Highlight API rather than `<mark>` elements, because a passage may run across list
 * items and code spans, and wrapping it would have to split the DOM it crosses.
 */
const marks = new Highlight()
const focusMark = new Highlight()
CSS.highlights.set('plan-comment', marks)
CSS.highlights.set('plan-comment-focus', focusMark)

/** The quote Claude gets is cut to this; it only has to find the passage again. */
const QUOTE_LIMIT = 160

/**
 * The review panel of one tab: the plan on the left, comments in the margin beside the
 * passage they are about, and the ways out in the head. It sits next to the terminal
 * rather than over it, so Claude's output stays readable while the plan is.
 *
 * A text review is the same panel with other ways out — approve, reject — and one thing
 * a plan does not have: the user may edit the text and approve their own version. Editing
 * and commenting do not mix, because a comment is anchored to the text it was made on:
 * editing is offered while there are no comments, and comments again once the edit is
 * done, on the edited text. Approving is offered only while there are no comments — a
 * comment asks for a change, and approving means "post exactly this".
 */
export class PlanReview {
  readonly el: HTMLDivElement
  private readonly title: HTMLSpanElement
  private readonly sub: HTMLSpanElement
  private readonly changesToggle: HTMLLabelElement
  private readonly changesBox: HTMLInputElement
  private readonly sendButton: HTMLButtonElement
  /** Plan: start with edits approved one by one. Text: unused. */
  private readonly manualButton?: HTMLButtonElement
  /** Plan: start in auto mode. Text: approve. The primary button either way. */
  private readonly approveButton: HTMLButtonElement
  private readonly rejectButton?: HTMLButtonElement
  private readonly editButton?: HTMLButtonElement
  private readonly editor?: HTMLTextAreaElement
  private readonly scroller: HTMLDivElement
  private readonly body: HTMLDivElement
  private readonly doc: HTMLElement
  private readonly margin: HTMLElement
  private readonly previousList: HTMLDivElement
  private readonly cards: HTMLDivElement
  private readonly general: HTMLTextAreaElement
  private readonly commentButton: HTMLButtonElement
  private readonly composer: HTMLDivElement
  private readonly composerQuote: HTMLDivElement
  private readonly composerText: HTMLTextAreaElement
  private readonly composerSave: HTMLButtonElement

  private plan = ''
  private round = 1
  private comments: PlanComment[] = []
  /** The passage the composer is open on, and the comment it edits, if any. */
  private drafting?: { start: number; end: number; editing?: number }
  private ownRanges: Range[] = []
  private open = false
  /** The text as Claude handed it over this round, before any edit of the user's. */
  private original = ''
  /** The text of the round this one answers, which changes are marked against. */
  private previousText?: string
  /** The general comment field's label, which says what that comment is about. */
  private readonly generalLabel: HTMLLabelElement

  constructor(private readonly mode: ReviewMode) {
    const text = mode.kind === 'text'
    this.el = document.createElement('div')
    this.el.className = text ? 'plan-review text-review' : 'plan-review'
    // Focusable, so a click into the plan keeps the keyboard here instead of the focus
    // guard handing it back to the terminal.
    this.el.tabIndex = -1

    const head = document.createElement('div')
    head.className = 'plan-head'
    const titles = document.createElement('div')
    titles.className = 'plan-titles'
    this.title = document.createElement('span')
    this.title.className = 'plan-title'
    this.title.textContent = text ? 'Text review' : 'Plan review'
    this.sub = document.createElement('span')
    this.sub.className = 'plan-sub'
    titles.append(this.title, this.sub)

    this.changesBox = document.createElement('input')
    this.changesBox.type = 'checkbox'
    this.changesBox.checked = true
    this.changesBox.addEventListener('change', () =>
      this.doc.classList.toggle('show-changes', this.changesBox.checked)
    )
    this.changesToggle = document.createElement('label')
    this.changesToggle.className = 'plan-toggle'
    this.changesToggle.append(this.changesBox, 'Show changes')

    const passButton = this.button(text ? 'Decide in terminal' : 'Keep planning in terminal', () =>
      this.pass()
    )
    passButton.title = text
      ? 'Esc — Claude asks in the terminal what to do with the text'
      : 'Esc — Claude Code asks in the terminal instead'
    this.sendButton = this.button('Send comments', () => void this.send())
    this.sendButton.title = text
      ? 'Ctrl+Enter — Claude revises the text and presents it again'
      : 'Ctrl+Enter — Claude revises the plan and presents it again'

    // Its own row of the head, so a narrow panel wraps the buttons rather than the title.
    const actions = document.createElement('div')
    actions.className = 'plan-actions'
    if (text) {
      this.editButton = this.button('Edit text', () => this.toggleEditing())
      this.rejectButton = this.button('Reject', () => this.reject())
      this.rejectButton.title = 'Claude does not post the text. A general comment goes along as the reason.'
      this.approveButton = this.button('Approve', () => this.approveText())
      this.approveButton.className = 'primary'
      actions.append(
        this.changesToggle,
        passButton,
        this.editButton,
        this.sendButton,
        this.rejectButton,
        this.approveButton
      )
    } else {
      // The first two choices of Claude Code's own menu, which these answer for it.
      this.manualButton = this.button('Start, approve edits', () => this.approve('default'))
      this.approveButton = this.button('Start in auto mode', () => this.approve('auto'))
      this.approveButton.className = 'primary'
      actions.append(
        this.changesToggle,
        passButton,
        this.sendButton,
        this.manualButton,
        this.approveButton
      )
    }
    head.append(titles, actions)

    this.scroller = document.createElement('div')
    this.scroller.className = 'plan-scroll'
    this.body = document.createElement('div')
    this.body.className = 'plan-body'
    this.doc = document.createElement('article')
    this.doc.className = 'plan-doc show-changes'
    this.margin = document.createElement('aside')
    this.margin.className = 'plan-margin'
    this.previousList = document.createElement('div')
    this.previousList.className = 'plan-previous'
    this.cards = document.createElement('div')
    this.cards.className = 'plan-cards'
    this.margin.append(this.previousList, this.cards)

    this.commentButton = document.createElement('button')
    this.commentButton.className = 'plan-comment-button'
    this.commentButton.textContent = 'Comment'
    this.commentButton.title = 'C'
    // Keeps the selection: a button that takes the focus on mousedown would clear it.
    this.commentButton.addEventListener('mousedown', (ev) => ev.preventDefault())
    this.commentButton.addEventListener('click', () => this.composeOnSelection())

    this.composer = document.createElement('div')
    this.composer.className = 'plan-composer'
    this.composerQuote = document.createElement('div')
    this.composerQuote.className = 'plan-composer-quote'
    const composerLabel = document.createElement('label')
    composerLabel.className = 'plan-label'
    composerLabel.textContent = 'Your comment'
    this.composerText = document.createElement('textarea')
    this.composerText.rows = 3
    // Comments are as often German as English; red squiggles under half of them help nobody.
    this.composerText.spellcheck = false
    composerLabel.htmlFor = this.composerText.id = `plan-comment-${crypto.randomUUID()}`
    const composerFoot = document.createElement('div')
    composerFoot.className = 'plan-composer-foot'
    const hint = document.createElement('span')
    hint.className = 'plan-hint'
    hint.textContent = 'Ctrl+Enter adds · Esc discards'
    const discard = this.button('Discard', () => this.closeComposer())
    this.composerSave = this.button('Add comment', () => this.saveComment())
    this.composerSave.className = 'primary'
    composerFoot.append(hint, discard, this.composerSave)
    this.composer.append(this.composerQuote, composerLabel, this.composerText, composerFoot)
    this.composerText.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.closeComposer()
      else if (ev.key === 'Enter' && ev.ctrlKey) this.saveComment()
      else return
      ev.preventDefault()
      ev.stopPropagation()
    })

    this.body.append(this.doc, this.margin, this.commentButton, this.composer)
    if (text) {
      // The text as Markdown, in place of the rendered one while the user edits it.
      this.editor = document.createElement('textarea')
      this.editor.className = 'plan-editor'
      this.editor.spellcheck = false
      this.editor.setAttribute('aria-label', 'Text')
      this.editor.addEventListener('input', () => this.updateCount())
      this.body.appendChild(this.editor)
    }
    this.scroller.appendChild(this.body)

    const foot = document.createElement('div')
    foot.className = 'plan-foot'
    this.generalLabel = document.createElement('label')
    this.generalLabel.className = 'plan-label'
    this.generalLabel.textContent = text ? 'Comment on the whole text' : 'Comment on the whole plan'
    this.general = document.createElement('textarea')
    this.general.rows = 2
    this.general.spellcheck = false
    this.general.placeholder = text
      ? 'Optional, sent along with the comments — or as the reason for a rejection'
      : 'Optional, sent along with the comments'
    this.generalLabel.htmlFor = this.general.id = `plan-general-${crypto.randomUUID()}`
    this.general.addEventListener('input', () => this.updateCount())
    foot.append(this.generalLabel, this.general)

    this.el.append(head, this.scroller, foot)

    this.el.addEventListener('keydown', (ev) => this.onKey(ev))
    document.addEventListener('selectionchange', () => this.placeCommentButton())
    new ResizeObserver(() => this.layout()).observe(this.doc)
  }

  isOpen(): boolean {
    return this.open
  }

  /**
   * Shows a plan. `previous` is the round it answers, whose comments are listed and whose
   * text the changes are measured against; `draft` is what the user had written on this
   * very plan before stepping out to the terminal.
   */
  show(plan: string, opts: { previous?: PlanRound; draft?: PlanRound; heading?: TextHeading }): void {
    this.plan = this.original = plan
    this.round = (opts.previous?.round ?? 0) + 1
    this.setEditing(false)
    this.doc.replaceChildren(renderPlan(plan))
    this.closeComposer()

    // A draft is what the user had written on this very text: same text, or their own
    // edit of it, which is what the draft then holds.
    const draft =
      opts.draft && (opts.draft.plan === plan || opts.draft.original === plan) ? opts.draft : undefined
    if (draft && draft.plan !== plan) {
      this.plan = draft.plan
      this.doc.replaceChildren(renderPlan(draft.plan))
    }
    this.comments = draft ? draft.comments.map((c) => ({ ...c })) : []
    this.general.value = draft?.general ?? ''

    this.previousText = opts.previous?.plan
    const changed = opts.previous ? this.markChanges(opts.previous.plan) : 0
    this.changesToggle.hidden = !opts.previous
    if (opts.heading) {
      this.title.textContent = opts.heading.title
      this.title.title = opts.heading.title
    }
    const where = opts.heading ? `${opts.heading.target} · ` : ''
    this.sub.textContent = opts.previous
      ? `${where}round ${this.round} · ${changed === 0 ? 'unchanged' : changed === 1 ? '1 passage changed' : `${changed} passages changed`}`
      : `${where}round ${this.round}`
    this.showPrevious(opts.previous)

    this.open = true
    this.el.classList.add('visible')
    this.scroller.scrollTop = 0
    this.renderCards()
    this.updateCount()
  }

  /** Takes the panel down and returns what was written on it. */
  hide(): PlanRound {
    const draft = this.snapshot()
    this.setEditing(false)
    this.open = false
    this.el.classList.remove('visible')
    this.closeComposer()
    this.setOwnRanges([])
    this.commentButton.classList.remove('visible')
    return draft
  }

  focus(): void {
    if (this.composer.classList.contains('visible')) this.composerText.focus()
    else if (this.isEditing()) this.editor?.focus()
    else this.el.focus({ preventScroll: true })
  }

  /* ---------------------------------------------------------- Answers */

  /** The comments are not dropped: they go along with the plan as what to do differently. */
  private approve(mode: PlanStartMode): void {
    if (this.mode.kind !== 'plan') return
    this.mode.handlers.approve(mode, this.pendingCount() > 0 ? this.notes() : undefined)
  }

  /** Exactly the text on show — or in the editor, if the user did not press "Done" first. */
  private approveText(): void {
    if (this.mode.kind !== 'text' || this.pendingCount() > 0) return
    const text = this.currentText()
    this.mode.handlers.approve(text, text !== this.original)
  }

  private reject(): void {
    if (this.mode.kind !== 'text') return
    this.mode.handlers.reject(this.general.value.trim() || undefined)
  }

  private send(): void {
    if (this.pendingCount() === 0) return
    if (this.isEditing()) this.setEditing(false)
    this.mode.handlers.revise(this.feedback(), this.snapshot())
  }

  private pass(): void {
    this.mode.handlers.pass(this.snapshot())
  }

  /**
   * The text Claude gets back as the reason the plan was not accepted. Each comment
   * quotes its passage, because the comment has to make sense to Claude on its own and
   * the passage may be reworded by the time it is read.
   */
  private feedback(): string {
    if (this.mode.kind === 'text') {
      const parts = [
        'The user reviewed the text in aterm and asks for changes. Revise the text to address the comments below, then call review_text again with the revised text. Do not post anything before it is approved.'
      ]
      // Their edit is the version to revise: it is what the comments were made on.
      if (this.plan !== this.original) {
        parts.push(`The user edited the text themselves. Revise their version, which is:\n\n${this.plan}`)
      }
      if (this.comments.length) parts.push('Comments on the text:')
      return [...parts, ...this.commentParts()].join('\n\n')
    }
    const parts = [
      'The user chose to stay in plan mode and continue planning. They reviewed this plan in aterm and left comments. Revise the plan to address them, then present the revised plan again.'
    ]
    if (this.comments.length) parts.push('Comments on the plan:')
    return [...parts, ...this.commentParts()].join('\n\n')
  }

  /* ---------------------------------------------------------- Editing */

  private isEditing(): boolean {
    return this.el.classList.contains('editing')
  }

  private currentText(): string {
    return this.isEditing() && this.editor ? this.editor.value : this.plan
  }

  private toggleEditing(): void {
    if (!this.isEditing() && this.comments.length > 0) return
    this.setEditing(!this.isEditing())
  }

  /**
   * Into the editor with the text as it stands, or out of it with what was written there,
   * rendered again. An edit that only touched whitespace at the ends changes nothing.
   */
  private setEditing(on: boolean): void {
    const editor = this.editor
    if (!editor || on === this.isEditing()) return
    if (on) {
      this.closeComposer()
      this.commentButton.classList.remove('visible')
      editor.value = this.plan
      this.el.classList.add('editing')
      editor.focus()
      editor.setSelectionRange(0, 0)
      editor.scrollTop = 0
    } else {
      this.el.classList.remove('editing')
      const value = editor.value.trim() === this.plan.trim() ? this.plan : editor.value
      if (value !== this.plan) {
        this.plan = value
        this.doc.replaceChildren(renderPlan(value))
        if (this.previousText !== undefined) this.markChanges(this.previousText)
      }
      if (this.open) this.el.focus({ preventScroll: true })
    }
    this.updateCount()
  }

  /**
   * What an approval appends to the plan: Claude carries out the plan, so that is where
   * the comments have to stand, and the plan file keeps them too.
   */
  private notes(): string {
    return [
      '## Review comments',
      'The user approved this plan in aterm with the comments below. Where a comment differs from the plan above, follow the comment.',
      ...this.commentParts()
    ].join('\n\n')
  }

  private commentParts(): string[] {
    const parts = this.comments.map(
      (comment, index) => `${index + 1}. On "${comment.quote}":\n${indent(comment.text)}`
    )
    const general = this.general.value.trim()
    if (general) parts.push(`On the plan as a whole:\n${indent(general)}`)
    return parts
  }

  private snapshot(): PlanRound {
    return {
      plan: this.currentText(),
      original: this.original,
      comments: this.comments.map((c) => ({ ...c })),
      general: this.general.value,
      round: this.round
    }
  }

  private pendingCount(): number {
    return this.comments.length + (this.general.value.trim() ? 1 : 0)
  }

  private updateCount(): void {
    const n = this.pendingCount()
    this.sendButton.disabled = n === 0
    this.sendButton.textContent = n === 0 ? 'Send comments' : n === 1 ? 'Send 1 comment' : `Send ${n} comments`
    if (this.mode.kind === 'text') {
      const edited = this.currentText() !== this.original
      this.approveButton.disabled = n > 0
      this.approveButton.textContent = edited ? 'Approve with my edits' : 'Approve'
      this.approveButton.title =
        n > 0
          ? 'Comments ask for changes: send them, or remove them to approve'
          : edited
            ? 'Claude posts your edited version, word for word'
            : 'Claude posts the text, word for word'
      if (this.editButton) {
        const editing = this.isEditing()
        this.editButton.textContent = editing ? 'Done editing' : 'Edit text'
        this.editButton.disabled = !editing && this.comments.length > 0
        this.editButton.title = editing
          ? 'Esc — back to the rendered text, to comment on it'
          : this.comments.length > 0
            ? 'Comments are anchored to the text: send or remove them before editing'
            : 'Change the wording yourself, then approve your version'
      }
      return
    }
    const along = n === 0 ? '' : n === 1 ? ' — your comment goes along' : ` — your ${n} comments go along`
    if (this.manualButton) this.manualButton.title = `Claude carries out the plan and asks before each edit${along}`
    this.approveButton.title = `Claude carries out the plan in auto mode${along}`
  }

  /* --------------------------------------------------------- Keyboard */

  private onKey(ev: KeyboardEvent): void {
    // Esc in the editor ends the edit, not the review: it is one keystroke from losing
    // the panel, and the edit is kept either way.
    if (ev.key === 'Escape' && this.isEditing()) {
      ev.preventDefault()
      this.setEditing(false)
      return
    }
    if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault()
      this.pass()
      return
    }
    if (ev.key === 'Enter' && ev.ctrlKey) {
      ev.preventDefault()
      this.send()
      return
    }
    const typing = ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement
    if (!typing && !ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === 'c' && this.selectionRange()) {
      ev.preventDefault()
      this.composeOnSelection()
    }
  }

  /* --------------------------------------------------------- Comments */

  /** The selection, when it lies inside the plan and is not empty. */
  private selectionRange(): Range | undefined {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined
    const range = selection.getRangeAt(0)
    if (!this.doc.contains(range.startContainer) || !this.doc.contains(range.endContainer)) {
      return undefined
    }
    return range.toString().trim() ? range : undefined
  }

  private placeCommentButton(): void {
    const range = this.open && !this.drafting ? this.selectionRange() : undefined
    this.commentButton.classList.toggle('visible', Boolean(range))
    if (!range) return
    const rects = range.getClientRects()
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
    const origin = this.body.getBoundingClientRect()
    this.commentButton.style.top = `${last.bottom - origin.top + 6}px`
    this.commentButton.style.left = `${Math.max(0, last.right - origin.left - 40)}px`
  }

  private composeOnSelection(): void {
    const range = this.selectionRange()
    if (!range) return
    const start = offsetIn(this.doc, range.startContainer, range.startOffset)
    const end = offsetIn(this.doc, range.endContainer, range.endOffset)
    document.getSelection()?.removeAllRanges()
    this.openComposer({ start, end })
  }

  private openComposer(at: { start: number; end: number; editing?: number }): void {
    const range = rangeIn(this.doc, at.start, at.end)
    if (!range) return
    this.drafting = at
    this.commentButton.classList.remove('visible')
    this.composerQuote.textContent = `on "${quoteOf(range)}"`
    this.composerText.value = at.editing !== undefined ? this.comments[at.editing].text : ''
    this.composerSave.textContent = at.editing !== undefined ? 'Save' : 'Add comment'

    const rects = range.getClientRects()
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
    const origin = this.body.getBoundingClientRect()
    const left = Math.min(
      Math.max(0, last.left - origin.left - 40),
      Math.max(0, this.body.clientWidth - 400)
    )
    this.composer.style.top = `${last.bottom - origin.top + 8}px`
    this.composer.style.left = `${left}px`
    this.composer.classList.add('visible')
    this.updateMarks()
    this.composerText.focus()
    this.composer.scrollIntoView({ block: 'nearest' })
  }

  private closeComposer(): void {
    const wasOpen = this.composer.classList.contains('visible')
    this.drafting = undefined
    this.composer.classList.remove('visible')
    this.updateMarks()
    if (wasOpen && this.open) this.el.focus({ preventScroll: true })
  }

  private saveComment(): void {
    const at = this.drafting
    const text = this.composerText.value.trim()
    if (!at) return
    if (!text) {
      // Saving an emptied comment is how it is taken back.
      if (at.editing !== undefined) this.comments.splice(at.editing, 1)
    } else {
      const range = rangeIn(this.doc, at.start, at.end)
      const comment = { start: at.start, end: at.end, quote: range ? quoteOf(range) : '', text }
      if (at.editing !== undefined) this.comments[at.editing] = comment
      else this.comments.push(comment)
      this.comments.sort((a, b) => a.start - b.start)
    }
    this.closeComposer()
    this.renderCards()
    this.updateCount()
  }

  private removeComment(index: number): void {
    this.comments.splice(index, 1)
    this.renderCards()
    this.updateCount()
    this.el.focus({ preventScroll: true })
  }

  private renderCards(): void {
    this.cards.replaceChildren(
      ...this.comments.map((comment, index) => {
        const card = document.createElement('div')
        card.className = 'plan-card'

        const top = document.createElement('div')
        top.className = 'plan-card-top'
        const badge = document.createElement('span')
        badge.className = 'plan-badge'
        badge.textContent = String(index + 1)
        const quote = document.createElement('span')
        quote.className = 'plan-card-quote'
        quote.textContent = `on "${comment.quote}"`
        const remove = document.createElement('button')
        remove.className = 'plan-card-remove'
        remove.textContent = '×'
        remove.setAttribute('aria-label', 'Remove comment')
        remove.addEventListener('click', (ev) => {
          ev.stopPropagation()
          this.removeComment(index)
        })
        top.append(badge, quote, remove)

        const text = document.createElement('div')
        text.className = 'plan-card-text'
        text.textContent = comment.text

        card.append(top, text)
        card.title = 'Click to edit'
        card.addEventListener('click', () =>
          this.openComposer({ start: comment.start, end: comment.end, editing: index })
        )
        card.addEventListener('mouseenter', () => this.updateMarks(index))
        card.addEventListener('mouseleave', () => this.updateMarks())
        return card
      })
    )
    this.updateMarks()
    this.layout()
  }

  /** Puts every card beside its passage, pushed down where they would overlap. */
  private layout(): void {
    if (!this.open) return
    // Measured against the card column itself, which starts below the previous round's
    // comments: a card never climbs over those.
    const origin = this.cards.getBoundingClientRect()
    let cursor = 0
    const cards = [...this.cards.children] as HTMLElement[]
    this.comments.forEach((comment, index) => {
      const card = cards[index]
      const range = rangeIn(this.doc, comment.start, comment.end)
      const anchor = range ? range.getBoundingClientRect().top - origin.top : cursor
      const top = Math.max(anchor, cursor)
      card.style.top = `${top}px`
      cursor = top + card.offsetHeight + 8
    })
    this.cards.style.height = `${cursor}px`
  }

  private updateMarks(focused?: number): void {
    const ranges: Range[] = []
    const focusRanges: Range[] = []
    if (this.open) {
      this.comments.forEach((comment, index) => {
        const range = rangeIn(this.doc, comment.start, comment.end)
        if (!range) return
        ranges.push(range)
        if (index === focused || index === this.drafting?.editing) focusRanges.push(range)
      })
      if (this.drafting && this.drafting.editing === undefined) {
        const range = rangeIn(this.doc, this.drafting.start, this.drafting.end)
        if (range) focusRanges.push(range)
      }
    }
    this.setOwnRanges(ranges, focusRanges)
  }

  private setOwnRanges(ranges: Range[], focusRanges: Range[] = []): void {
    for (const range of this.ownRanges) {
      marks.delete(range)
      focusMark.delete(range)
    }
    for (const range of ranges) marks.add(range)
    for (const range of focusRanges) focusMark.add(range)
    this.ownRanges = [...ranges, ...focusRanges]
  }

  /* ---------------------------------------------------------- Rounds */

  /**
   * Marks every block whose text the previous round did not have. Measured by block
   * rather than by word: what the user wants to see is which steps moved, and a block
   * is also what the eye finds again.
   */
  private markChanges(previousPlan: string): number {
    const before = document.createElement('div')
    before.appendChild(renderPlan(previousPlan))
    const known = new Set(blocks(before).map(blockText))
    let changed = 0
    for (const block of blocks(this.doc)) {
      const text = blockText(block)
      if (!text || known.has(text)) continue
      block.classList.add('changed')
      changed++
    }
    return changed
  }

  private showPrevious(previous: PlanRound | undefined): void {
    this.previousList.replaceChildren()
    const comments = previous?.comments ?? []
    const general = previous?.general.trim()
    if (!previous || (comments.length === 0 && !general)) return

    const heading = document.createElement('div')
    heading.className = 'plan-previous-head'
    heading.textContent = `Round ${previous.round} comments`
    this.previousList.appendChild(heading)

    const now = normalize(this.doc.textContent ?? '')
    for (const comment of comments) {
      // A passage that no longer reads the same was worked on. Whether that answers the
      // comment is the user's call; the tick only says where to look.
      const touched = !now.includes(normalize(comment.quote.replace(/…$/, '')))
      this.previousList.appendChild(previousRow(comment.text, touched))
    }
    if (general) this.previousList.appendChild(previousRow(general, undefined))
  }

  private button(label: string, run: () => void): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = label
    el.addEventListener('click', run)
    return el
  }
}

function previousRow(text: string, touched: boolean | undefined): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'plan-previous-row'
  const mark = document.createElement('span')
  mark.className = touched ? 'plan-tick' : 'plan-dot'
  mark.textContent = touched ? '✓' : '·'
  row.title =
    touched === undefined
      ? 'On the plan as a whole'
      : touched
        ? 'The passage this is about has changed'
        : 'The passage this is about reads as before'
  const body = document.createElement('span')
  body.textContent = text
  row.append(mark, body)
  return row
}

/** The elements a change is marked on. */
function blocks(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, li, pre, tr')]
}

/** A block's own text — a list item without the list nested in it. */
function blockText(block: HTMLElement): string {
  if (block.tagName !== 'LI') return normalize(block.textContent ?? '')
  let text = ''
  for (const child of block.childNodes) {
    if (child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')) continue
    text += child.textContent ?? ''
  }
  return normalize(text)
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function quoteOf(range: Range): string {
  const text = normalize(range.toString())
  return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT - 1)}…` : text
}

function indent(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `   ${line}`)
    .join('\n')
}

/** A DOM position as a character offset into `root`'s text. */
function offsetIn(root: Node, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(root, 0)
  range.setEnd(node, offset)
  return range.toString().length
}

/** The range between two character offsets into `root`'s text. */
function rangeIn(root: Node, start: number, end: number): Range | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let seen = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).length
    if (!started && start <= seen + length) {
      range.setStart(node, start - seen)
      started = true
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen)
      return range
    }
    seen += length
  }
  return undefined
}
