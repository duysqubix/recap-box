import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, ThemeKey } from 'claude-code'
import type { Stage } from '../types'

const PANE = 'recap'
const EVERY_S = 60
const recap = atom({ plugin: 'recap-box', key: 'recap' } as const, null)
const stage = atom({ plugin: 'recap-box', key: 'stage' } as const, null)
// Seconds to the next check, counted down in the box.
const left = atom({ plugin: 'recap-box', key: 'left' } as const, EVERY_S)

// The stages a recap can name, each drawn in its theme color.
const STAGES: Record<Stage, ThemeKey> = {
  researching: 'ide',
  planning: 'planMode',
  coding: 'claude',
  testing: 'autoAccept',
  debugging: 'error',
  reviewing: 'permission',
  writing: 'warning',
  shipping: 'success',
}

const SYSTEM =
  'You keep a live recap of a Claude Code session for the person running it. ' +
  `Line 1: one word, the stage the work is in, from: ${Object.keys(STAGES).join(', ')}. ` +
  'Then 2-3 short plain sentences, 60 words at most: the goal, what just ' +
  'happened, and what is under way or next. No preamble, no markdown.'

// The transcript's tail as plain lines, system reminders dropped.
const transcript = (messages: readonly SessionMessage[]) =>
  messages
    .flatMap(m => {
      const text = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      const tools = m.toolUses.map(
        t => `  ${t.tool} ${String(t.input.file_path ?? t.input.command ?? t.input.description ?? '').slice(0, 80)}`,
      )
      return text ? [`${m.role}: ${text.slice(0, 400)}`, ...tools] : tools
    })
    .join('\n')
    .slice(-8000)

// One line of plain text: a Text refuses control characters.
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, ' ').trim()

let seen = ''
let epoch = 0
let isBusy = false

// Re-summarize when the transcript's tail changed, and only while the box is drawn.
async function refresh($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  const at = epoch
  try {
    const panes = await $.ui.panes()
    if (!panes.some(p => p.id === PANE && p.isPlaced)) return
    // Compared by content: messages() holds only the newest 4096 rows, so a count stalls.
    const tail = transcript((await $.session.messages()).slice(-60))
    if (!tail || tail === seen || at !== epoch) return

    // Seen even when the call fails, so a retry waits for new activity.
    seen = tail
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `Previous recap: ${(await read($, recap)) ?? 'none'}\n\nTranscript tail, oldest first:\n${tail}`,
      maxTokens: 200,
      effort: 'low',
      timeoutMs: 30_000,
    })
    // A /clear while the call ran makes this the old conversation's recap. Checked
    // inside update: a write that races session.end's re-runs and keeps its null.
    if (reply.isAnswered) {
      // Line 1 names the stage; a reply without one is all recap and keeps the last stage.
      const [first = '', ...rest] = reply.text.trim().split('\n')
      const word = first.toLowerCase().replace(/[^a-z]/g, '')
      const isStage = Object.hasOwn(STAGES, word)
      // A lone word on line 1 is the stage line even when it names no stage ("wrapping").
      const hasLine = isStage || (rest.length > 0 && /^\W*[a-z]+\W*$/i.test(first))
      if (isStage) await update($, stage, old => (at === epoch ? (word as Stage) : old))
      await update($, recap, old => (at === epoch ? clean(hasLine ? rest.join(' ') : reply.text) || old : old))
    }
  } catch (err) {
    // Only a request the engine refuses to send rejects (a blocked model): say so in the box.
    await update($, recap, old => (at === epoch ? clean(`No recap: ${String(err)}`) : old))
  } finally {
    isBusy = false
  }
}

// Each second: count the box down, and at zero check for new activity.
async function tick($: EngineInterface) {
  if ((await update($, left, n => (n > 1 ? n - 1 : EVERY_S))) === EVERY_S) await refresh($)
}

export const register: Register = on => {
  // Opened on every start: the desktop app, VS Code and mobile attach after a start without a surface.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'recap-box', description: 'Open the session recap box' })
    void $.ui.open({ id: PANE, title: 'Recap', columns: 40 })
    $.clock.every(1000, () => void tick($))

    return next(e)
  })

  on('command.run', { command: 'recap-box' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Recap', columns: 40 })

    return { text: 'Recap box opened.' }
  })

  // A /clear or /resume starts another conversation: its recap starts over.
  on('session.end', async ($, e, next) => {
    seen = ''
    epoch += 1
    await update($, recap, () => null)
    await update($, stage, () => null)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const text = await read($, recap)
    const name = await read($, stage)
    const n = await read($, left)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {name && <Text bold color={STAGES[name]}>{name.toUpperCase()}</Text>}
          {text === null ? <Text dimColor>Waiting for activity.</Text> : <Text>{text}</Text>}
        </Box>
        <Text dimColor>{`next check in ${n}s`}</Text>
      </Box>
    )
  })
}
