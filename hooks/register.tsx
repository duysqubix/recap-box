import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, SessionMessage, ThemeKey, ToolUseSummary } from 'claude-code'
import type { Stage } from '../types'

const PANE = 'recap'
const EVERY_S = 60
const recap = atom({ plugin: 'recap-box', key: 'recap' } as const, null)
// What the whole session works toward, pinned under the recap.
const goal = atom({ plugin: 'recap-box', key: 'goal' } as const, null)
// What the person asked for, the goal's source: their first prompt and newest eight.
// ponytail: prompts sent before the mod loaded (a resumed session) are missing; the goal then reads the tail.
const asks = atom({ plugin: 'recap-box', key: 'asks' } as const, [])
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

// What a call says the work is, first match wins; a call no rule names casts no vote.
// A word counts from its start ("latest" is no test), and a shell word only where a
// command starts or stands alone ("recap.test.tsx" runs no test).
const RULES: [RegExp, Stage][] = [
  [/^(Agent|Skill) .*\b(review|verif|critic\b|audit)|^ReportFindings/i, 'reviewing'],
  [/^(Agent|Skill) .*\b(plan|architect|analyst)|^(Enter|Exit)PlanMode/i, 'planning'],
  [/^(Agent|Skill) .*\b(debug|trac(e|ing))/i, 'debugging'],
  [/^(Agent|Skill) .*\b(explore|research|search|document-specialist)/i, 'researching'],
  [/^(Agent|Skill) .*\bwriter/i, 'writing'],
  [/^(Agent|Skill) .*\b(test|qa)/i, 'testing'],
  [/^(Agent|Skill) .*\b(execut|build|implement)/i, 'coding'],
  [/^Bash (.*[\s;&|(/])?(git (push|commit|tag)|gh (pr|release|run)|publish|deploy|ci-watch)([\s;&|)]|$)/s, 'shipping'],
  [/^Bash (.*[\s;&|(/])?(test|pytest|jest|vitest|tsc|validate|lint|check|clippy|ruff|mypy)([\s;&|)]|$)/s, 'testing'],
  [/^(Edit|Write|NotebookEdit) .*\.(md|mdx|txt|rst)$/i, 'writing'],
  [/^(Edit|Write|NotebookEdit) /, 'coding'],
  // Most other shell commands only look: grep, sed, cat, ls, git show.
  [/^(Read|Grep|Glob|WebSearch|WebFetch|LSP|Bash) /, 'researching'],
]

// A call as one line for the rules: the tool, then what it ran, touched, or was sent to do.
const call = ({ tool, input: i }: ToolUseSummary) =>
  `${tool} ${String(i.command ?? i.file_path ?? i.notebook_path ?? [i.subagent_type, i.skill, i.description].join(' '))}`

// The stage the tail's calls show: most of the last ten votes, the newest on a tie,
// and debugging while the newest check among them failed.
function stageOf(messages: readonly SessionMessage[]): Stage | undefined {
  const votes = messages
    .flatMap(m => m.toolUses)
    .flatMap(t => {
      const s = RULES.find(([re]) => re.test(call(t)))?.[1]
      return s ? [{ s, isError: t.isError }] : []
    })
    .slice(-10)
  if (votes.filter(v => v.s === 'testing').pop()?.isError) return 'debugging'
  const n = (s: Stage) => votes.filter(v => v.s === s).length

  return votes.map(v => v.s).reverse().sort((a, b) => n(b) - n(a))[0]
}

const SYSTEM =
  'You keep a live recap of a Claude Code session for anyone watching it, whether they write software or not. ' +
  'Use everyday words and short sentences: no jargon, no abbreviations, and no names of files, code, commands, ' +
  'tools or anything else coined during the work. Say what the work is for, not how it is done: ' +
  '"making sure the sign-in page works again", not "patching the auth middleware". ' +
  'Answer in two lines. First "Now:" and one or two sentences, 30 words at most, on what is happening at the end of the transcript. ' +
  'Then "Goal:" and one sentence, 25 words at most, on what the whole session is working toward, ' +
  'from what the person asked for. While the goal so far still fits, write "Goal: same". ' +
  'No preamble, no markdown.'

// The prompts in the person's own words: typed, sent from a phone or the web, from an SDK host, the owner's
// Slack ping, or a plugin that relays them as the person's (a voice or phone relay).
const isPerson = (o: PromptOrigin) =>
  ['composer', 'bridge', 'sdk', 'slack-ping'].includes(o.kind) || (o.kind === 'plugin' && o.asUser === true)

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

// The reply's labeled lines, in either order; a goal that says it is unchanged keeps the pinned one.
const GOAL = /^\W*goal\W*:[\s*]*(.*)$/im
const NOW = /^\W*now\W*:[\s*]*/im
const SAME = /^\W*(the )?(same|unchanged|no change|none)\b/i

// A cut can split an emoji's pair, and the API refuses a lone half: keep whole pairs, drop halves.
const whole = (text: string) => text.replace(/([\ud800-\udbff][\udc00-\udfff])|[\ud800-\udfff]/g, '$1')

let seen = ''
let epoch = 0
let isBusy = false

// While the box is drawn: read the stage, and re-summarize when the transcript's tail changed.
async function refresh($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  const at = epoch
  try {
    const panes = await $.ui.panes()
    if (!panes.some(p => p.id === PANE && p.isPlaced)) return
    const recent = (await $.session.messages()).slice(-60)
    // Read at every check: a call's result can land while the transcript reads the same.
    // A /clear while this check ran makes it the old conversation's. Checked inside
    // update: a write that races session.end's re-runs and keeps its null.
    const name = stageOf(recent)
    if (name) await update($, stage, old => (at === epoch ? name : old))
    // Compared by content: messages() holds only the newest 4096 rows, so a count stalls.
    const tail = transcript(recent)
    if (!tail || tail === seen || at !== epoch) return

    // Seen even when the call fails, so a retry waits for new activity.
    seen = tail
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: whole(
        `Goal so far: ${(await read($, goal)) ?? 'none'}\n` +
          `Previous recap: ${(await read($, recap)) ?? 'none'}\n\n` +
          `What the person asked for, oldest first:\n${(await read($, asks)).map(t => `- ${t}`).join('\n') || 'none'}\n\n` +
          `Transcript tail, oldest first:\n${tail}`,
      ),
      maxTokens: 200,
      effort: 'low',
      timeoutMs: 30_000,
    })
    if (reply.isAnswered) {
      // Every line but the goal's is the recap.
      const aim = clean(reply.text.match(GOAL)?.[1] ?? '')
      const now = clean(reply.text.replace(GOAL, '').replace(NOW, ''))
      await update($, recap, old => (at === epoch ? now || old : old))
      if (aim && !SAME.test(aim)) await update($, goal, old => (at === epoch ? aim : old))
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

  // Read here, where the engine says who sent a prompt: the transcript mixes in notices
  // and other sessions' messages, and carries a prompt typed mid-turn inside a reminder.
  // A command with a word or none after it asks for nothing (/clear, /effort max).
  on('prompt.submit', async ($, e, next) => {
    // What entered, as the hooks beneath left it: a dropped prompt has no text, a masked one its mask.
    const r = await next(e)
    const text = clean(r.text ?? '').slice(0, 1200)
    if (text && !e.isMeta && isPerson(e.origin) && (!e.command || /\s/.test(e.command.args.trim()))) {
      await update($, asks, list => (list.length < 9 ? [...list, text] : [...list.slice(0, 1), ...list.slice(2), text]))
    }

    return r
  })

  // A /clear or /resume starts another conversation: its recap and goal start over.
  on('session.end', async ($, e, next) => {
    seen = ''
    epoch += 1
    // First, so a prompt that follows the /clear at once is not wiped with the old asks.
    await update($, asks, () => [])
    await update($, recap, () => null)
    await update($, goal, () => null)
    await update($, stage, () => null)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const text = await read($, recap)
    const aim = await read($, goal)
    const name = await read($, stage)
    const n = await read($, left)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {name && <Text bold color={STAGES[name]}>{name.toUpperCase()}</Text>}
          {text === null ? !name && !aim && <Text dimColor>Waiting for activity.</Text> : <Text>{text}</Text>}
        </Box>
        {aim && (
          <Box flexDirection="column">
            <Text bold>GOAL</Text>
            <Text>{aim}</Text>
          </Box>
        )}
        <Text dimColor>{`next check in ${n}s`}</Text>
      </Box>
    )
  })
}
