import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, PromptOrigin, Register, SessionMessage, ThemeKey, ToolUseSummary } from 'claude-code'
import type { Stage } from '../types'

const PANE = 'recap'
const EVERY_S = 60
// The seconds `/recap-box update` takes: at most one Haiku call each check, and a check at least hourly.
const MIN_S = 10
const MAX_S = 3600
// Seconds between checks, read from the store at each start.
let every = EVERY_S
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
// A word counts from its start: "latest" is no test, "critical" no review.
const RULES: [RegExp, Stage][] = [
  [/^(Agent|Skill) .*\b(review|verif|critic\b|audit)|^ReportFindings/i, 'reviewing'],
  [/^(Agent|Skill) .*\b(plan|ralplan|architect|analyst)|^(Enter|Exit)PlanMode/i, 'planning'],
  [/^(Agent|Skill) .*\b(debug|trac(e|ing))/i, 'debugging'],
  [/^(Agent|Skill) .*\b(explore|research|search|document-specialist)/i, 'researching'],
  [/^(Agent|Skill) .*\bwriter/i, 'writing'],
  [/^(Agent|Skill) .*\b(test|qa)/i, 'testing'],
  [/^(Agent|Skill) .*\b(execut|build|implement)/i, 'coding'],
  [/^(Agent|Skill) .*\bgit-master/i, 'shipping'],
  [/^(Edit|Write|NotebookEdit) .*\.(md|mdx|txt|rst)$/i, 'writing'],
  [/^(Edit|Write|NotebookEdit) /, 'coding'],
  [/^(Read|Grep|Glob|WebSearch|WebFetch|LSP) /, 'researching'],
]

// A rule's stage for what a call names, then with its task's words: an agent or a skill
// goes by its kind, and by its task only when the kind names no stage.
const named = (head: string, task?: unknown) =>
  (RULES.find(([re]) => re.test(head)) ?? (task ? RULES.find(([re]) => re.test(`${head} ${String(task)}`)) : undefined))?.[1]

// A shell command goes by the commands it starts, never by an argument, a quote or a
// heredoc's text: "grep -rn test" looks, "npm test" tests. Every other command looks.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g
const QUOTED = /'[^']*'|"(\\.|[^"\\])*"/g
// What leads a command without being one: a variable, time, timeout 60, then.
const LEAD = /^([A-Za-z_]\w*=\S*|time|env|sudo|nohup|exec|if|then|else|while|until|do|!|timeout|\d+[smh]?)$/
// Only what sends work out: reading a pull request or a CI run is a look.
const SHIP =
  /^(git( -[Cc] \S+)* (push|commit|tag)|gh (pr (create|merge|ready)|release create|run (watch|rerun))|ci-watch|deploy|(npm|pnpm|yarn|bun|cargo|uv|poetry) publish)\b/
const TEST =
  /^((pytest|jest|vitest|tsc|ruff|mypy|eslint)|(npm|npx|pnpm|yarn|bun|bunx|uv|cargo|go|make|deno|poetry|python3?|claude)( -\S+| run| exec| x| plugin)* (test|check|validate|lint|clippy|typecheck|pytest|unittest|jest|vitest|tsc|ruff|mypy|eslint))\b/
// A run piped to tail exits 0 however it went: its output says.
const FAILED = /test result: FAILED|\b[1-9]\d* (fail|failed|failing)\b|^error(\[E\d+\])?:|\berror TS\d+:|Validation failed/m

function shellStage(command: string): Stage {
  const commands = command
    .replace(HEREDOC, '')
    .replace(QUOTED, '""')
    .split(/&&|\|\||[;|&\n(`{]|\$\(/)
    .map(part => {
      const words = part.split(/\s+/).filter(Boolean)
      while (words[0] && LEAD.test(words[0])) words.shift()
      // A program by its name, wherever it lives: ~/.claude/scripts/ci-watch, node_modules/.bin/vitest.
      return [words[0]?.split('/').pop(), ...words.slice(1)].join(' ')
    })
  if (commands.some(c => SHIP.test(c))) return 'shipping'

  return commands.some(c => TEST.test(c)) ? 'testing' : 'researching'
}

// A call by what it ran, the file it touched, or the kind of agent or skill it started.
const callStage = ({ tool, input: i }: ToolUseSummary) =>
  tool === 'Bash'
    ? shellStage(String(i.command ?? ''))
    : named(`${tool} ${String(i.file_path ?? i.notebook_path ?? i.subagent_type ?? i.skill ?? '')}`, i.description)

// The newest work: of the last five calls, the newest that does more than look, and debugging
// while the newest test run among them failed. A helper agent at work shows while the session
// waits on it or only looks.
function stageOf(messages: readonly SessionMessage[], agents: readonly AgentInfo[]): Stage | undefined {
  const votes = messages
    .flatMap(m => m.toolUses)
    .flatMap(t => {
      const s = callStage(t)
      return s ? [{ s, t }] : []
    })
    .slice(-5)
  // A run sent to the background answers when it starts, not how it ends.
  const run = votes.filter(v => v.s === 'testing' && !v.t.input.run_in_background).pop()?.t
  // An agent's answer is its report: "fixed the 2 failing tests" is no failed run.
  if (run && (run.isError || (run.tool === 'Bash' && FAILED.test(run.text ?? '')))) return 'debugging'
  // The session's own helpers at work, or waiting on their own runs: not a plugin's, nor one inside
  // another agent, nor a teammate in a pane of its own, whose status outlives a closed pane.
  // ponytail: with two at work, the one listed last shows; pick by start time if that misleads.
  const helper = agents
    .filter(a => ['running', 'waiting'].includes(a.status) && !a.parentId && !a.spawnedBy && a.id !== a.teammateId)
    .map(a => named(`Agent ${a.type}`, a.description))
    .filter(s => s !== undefined)
    .pop()
  // The model spoke last and called nothing: its turn is over.
  const last = messages.at(-1)
  const isWaiting = last?.role === 'assistant' && !last.toolUses.length

  return (isWaiting && helper) || votes.findLast(v => v.s !== 'researching')?.s || helper || votes.at(-1)?.s
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

// The reply's labeled lines, in either order; a goal that only says it still fits keeps the pinned one.
const GOAL = /^\W*goal\W*:[\s*]*(.*)$/im
const NOW = /^\W*now\W*:[\s*]*/im
const SAME = /^\W*(still )?(the )?(same|unchanged|no changes?|none)( one| goal)?( as before| so far| yet| from before)?\W*$/i

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
    // Read at every check: a call's result can land, or a helper start or end, while the transcript reads the same.
    // A /clear while this check ran makes it the old conversation's. Checked inside
    // update: a write that races session.end's re-runs and keeps its null.
    const name = stageOf(recent, await $.agent.list())
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
  if ((await update($, left, n => (n > 1 ? n - 1 : every))) === every) await refresh($)
}

export const register: Register = on => {
  // Opened on every start: the desktop app, VS Code and mobile attach after a start without a surface.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'recap-box',
      description: 'Open the session recap box, or set the seconds between its checks',
      argumentHint: '[update <seconds>]',
    })
    // The store is a file anyone can edit: a value out of range, or one that cannot be read, is the default.
    const kept = Number(await $.store.get('every').catch(() => undefined))
    every = Number.isInteger(kept) && kept >= MIN_S && kept <= MAX_S ? kept : EVERY_S
    await update($, left, () => every)
    void $.ui.open({ id: PANE, title: 'Recap', columns: 40 })
    $.clock.every(1000, () => void tick($))

    return next(e)
  })

  on('command.run', { command: 'recap-box' }, async ($, e) => {
    if (e.args.trim()) {
      const s = Number(/^update\s+(\d+)s?$/i.exec(e.args.trim())?.[1])
      if (!(s >= MIN_S && s <= MAX_S)) {
        return {
          text: `/recap-box opens the box; /recap-box update <seconds>, from ${MIN_S} to ${MAX_S}, sets the time between checks. The box checks every ${every}s.`,
        }
      }
      // Kept for later sessions, so saved first: a failed save changes nothing. The count starts over at the new length.
      await $.store.set('every', s)
      every = s
      await update($, left, () => s)

      return { text: `The box checks every ${s}s.` }
    }
    await $.ui.open({ id: PANE, title: 'Recap', columns: 40 })

    return { text: 'Recap box opened.' }
  })

  // Read here, where the engine says who sent a prompt: the transcript mixes in notices
  // and other sessions' messages, and carries a prompt typed mid-turn inside a reminder.
  // A command with a word or none after it asks for nothing (/clear, /effort max), nor does the box's own.
  on('prompt.submit', async ($, e, next) => {
    // What entered, as the hooks beneath left it: a dropped prompt has no text, a masked one its mask.
    const r = await next(e)
    const text = clean(r.text ?? '').slice(0, 1200)
    const isAsk = !e.command || (e.command.name !== 'recap-box' && /\s/.test(e.command.args.trim()))
    if (text && !e.isMeta && isPerson(e.origin) && isAsk) {
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
    // Again once the end is done: a check that started meanwhile read the old conversation.
    const r = await next(e)
    seen = ''
    epoch += 1
    await update($, recap, () => null)
    await update($, goal, () => null)
    await update($, stage, () => null)

    return r
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
