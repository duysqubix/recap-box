import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, PromptOrigin, SessionEndInput, SessionMessage, ToolUseSummary } from 'claude-code'

const PANE = {
  plugin: 'recap-box',
  component: 'Pane',
  requestId: 'recap',
  props: {
    title: 'Recap',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Nothing sits beneath the plugin: these hooks stand for the engine.
type Answer = { value: ModelCompleteResult } | { deny: string }
const say = (text: string): Answer => ({ value: { isAnswered: true, text, usage: USAGE } })
const CLEAR: SessionEndInput = { reason: 'clear', sessionId: 's1', resume: { id: 's1' } }

// A tool call, and an assistant turn that only makes calls.
let ids = 0
const use = (tool: string, input: Record<string, unknown>, isError?: true): ToolUseSummary => ({
  tool_use_id: `t${++ids}`,
  tool,
  input,
  ...(isError && { isError }),
})
const did = (...toolUses: ToolUseSummary[]): SessionMessage => ({ role: 'assistant', text: '', toolUses })
const EDIT = use('Edit', { file_path: '/r/hooks/register.tsx' })
const READ = use('Read', { file_path: '/r/hooks/register.tsx' })

// Answers with what reached it; the prompt stand-in masks a key and drops a marked prompt, as a settings hook might.
const engine = (
  on: On,
  messages: SessionMessage[] | (() => Promise<SessionMessage[]>),
  model: (e: ModelCompleteInput) => Answer | Promise<Answer>,
) => {
  const entered: string[] = []
  on('command.register', () => ({ value: { command: 'recap-box' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'recap', title: 'Recap', isShown: true, isFocused: false, isPlaced: true }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.messages', async () => ({ value: Array.isArray(messages) ? [...messages] : await messages() }))
  on('model.complete', async (_, e) => model(e))
  on('prompt.submit', (_, e) => {
    entered.push(e.text)

    return e.text === 'drop me' ? { drop: 'blocked' } : { text: e.text.replace('sk-live-123', '[masked]') }
  })

  return entered
}

test('the box recaps new activity once, with its stage, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say(' Building a\n recap mod.\x1b ')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  messages.push({ role: 'user', text: 'make a recap box <system-reminder>noise</system-reminder>', toolUses: [] }, did(EDIT))
  await clock.advance(60_000)
  await clock.advance(60_000)

  // Two checks, one change: one model call, reminders stripped.
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('user: make a recap box')
  expect(prompts[0]).not.toContain('noise')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /recap mod/ }))?.text).toBe('Building a recap mod.')
    const label = await ui.find({ type: 'Text', text: /CODING/ })
    expect(label?.text).toBe('CODING')
    expect(label?.props.bold).toBe(true)
    expect(label?.props.color).toBe('claude')
    await ui.unmount()
  }
})

test('the open box counts down to the next check, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [], () => ({ deny: 'nothing to recap' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Mounted first, so each count is a redraw of the open box.
  for (const [surface, shown] of [['terminal', 'next check in 45s'], ['desktop', 'next check in 30s']] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toBe('Waiting for activity.')
    await clock.advance(15_000)
    expect((await ui.find({ type: 'Text', text: /next check/ }))?.text).toBe(shown)
    await ui.unmount()
  }
})

test('a check runs every 60th second, never sooner', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  let calls = 0
  engine(on, messages, () => {
    calls += 1

    return { value: { isAnswered: true, text: 'A recap.', usage: USAGE } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(59_000)
  expect(calls).toBe(0)
  await clock.advance(1_000)
  expect(calls).toBe(1)

  messages.push({ role: 'assistant', text: 'two', toolUses: [] })
  await clock.advance(59_000)
  expect(calls).toBe(1)
  await clock.advance(1_000)
  expect(calls).toBe(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /A recap/ }))?.text).toBe('A recap.')
  await ui.unmount()
})

test('a refused model call says so in the box', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ role: 'user', text: 'hi', toolUses: [] }], () => ({ deny: 'model blocked' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No recap/ }))?.text).toContain('model blocked')
  await ui.unmount()
})

test('a start without a surface counts down once the desktop app attaches', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [], () => ({ deny: 'nothing to recap' }))

  // The desktop app, VS Code and mobile start this way, then attach.
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'd1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(15_000)
  expect((await ui.find({ type: 'Text', text: /next check/ }))?.text).toBe('next check in 45s')
  await ui.unmount()
})

test("a /clear drops the stage, the goal and the person's asks with the recap", async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT)]
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say('Building it.\nGoal: A recap box.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'build a recap box', wait: false, origin: { kind: 'composer' } })
  await clock.advance(60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(await shown()).toEqual(['CODING', 'Building it.', 'GOAL', 'A recap box.', 'next check in 60s'])
  messages.length = 0
  await $.session.end(CLEAR)
  expect(await shown()).toEqual(['Waiting for activity.', 'next check in 60s'])
  await ui.unmount()

  // The next conversation's first check knows none of the old one's asks.
  messages.push({ role: 'user', text: 'two', toolUses: [] })
  await clock.advance(60_000)
  expect(prompts[0]).toContain('oldest first:\n- build a recap box\n')
  expect(prompts[1]).toContain('oldest first:\nnone\n')
})

test('a /clear during a check keeps the old stage out of the new conversation', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT)]
  engine(on, messages, async () => {
    await clock.sleep(20_000)

    return say('Old talk.\nGoal: Old aim.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  // The stage shows while the recap is still being written, with no placeholder under it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['CODING', 'next check in 60s'])
  messages.length = 0
  await $.session.end(CLEAR)
  await clock.advance(20_000)

  expect(await ui.find({ type: 'Text', text: /CODING|GOAL|Old aim/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toBe('Waiting for activity.')
  await ui.unmount()
})

test('a /clear while a check reads the transcript keeps the old stage out', async ($, on) => {
  const clock = mock.clock(on)
  const read = async () => {
    await clock.sleep(5_000)

    return [did(EDIT)]
  }
  engine(on, read, () => say('Now: Old talk.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(60_000)
  await $.session.end(CLEAR)
  await clock.advance(5_000)

  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Waiting for activity.', 'next check in 55s'])
  await ui.unmount()
})

test('each kind of tool call names its stage', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  engine(on, messages, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const cases: [ToolUseSummary, string][] = [
    [use('Read', { file_path: '/r/README.md' }), 'RESEARCHING'],
    // Quoted words, a test file's name and a word that ends in one run nothing.
    [use('Bash', { command: 'grep -n "git push origin" README.md' }), 'RESEARCHING'],
    [use('Bash', { command: 'sed -n 1,9p tests/recap.test.tsx' }), 'RESEARCHING'],
    [use('Bash', { command: 'cat logs/latest' }), 'RESEARCHING'],
    [use('Agent', { subagent_type: 'Plan', description: 'Plan the change', prompt: 'p' }), 'PLANNING'],
    [use('ExitPlanMode', {}), 'PLANNING'],
    // An agent of no named kind goes by its task.
    [use('Agent', { subagent_type: 'general-purpose', description: 'Research the engine docs', prompt: 'p' }), 'RESEARCHING'],
    // A task word inside another word names none: no stage, so the recap shows first.
    [use('Agent', { subagent_type: 'general-purpose', description: 'Retrace the latest release', prompt: 'p' }), 'Working.'],
    [EDIT, 'CODING'],
    // A builder's task that names a critical bug is no review.
    [use('Agent', { subagent_type: 'oh-my-claudecode:executor', description: 'Fix the critical bug', prompt: 'p' }), 'CODING'],
    [use('Bash', { command: 'cd /r && claude plugin test .' }), 'TESTING'],
    [use('Bash', { command: 'cargo test' }, true), 'DEBUGGING'],
    [use('Agent', { subagent_type: 'oh-my-claudecode:code-reviewer', description: 'Review the diff', prompt: 'p' }), 'REVIEWING'],
    [use('Skill', { skill: 'code-review' }), 'REVIEWING'],
    [use('Write', { file_path: '/r/README.md' }), 'WRITING'],
    [use('Bash', { command: 'git add -A && git commit -m "Pin the goal" && git push' }), 'SHIPPING'],
    [use('Bash', { command: '~/.claude/scripts/ci-watch' }), 'SHIPPING'],
  ]
  for (const [call, stage] of cases) {
    await $.session.end(CLEAR)
    messages.splice(0, messages.length, did(call))
    await clock.advance(60_000)
    expect({ call: call.input, shown: (await ui.findAll({ type: 'Text' }))[0]?.text }).toEqual({ call: call.input, shown: stage })
  }
  await ui.unmount()
})

test('the stage is what most of the last ten calls do, the newest on a tie', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT, EDIT, EDIT, EDIT, EDIT, EDIT, READ, READ, READ, READ)]
  engine(on, messages, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text

  await clock.advance(60_000)
  expect(await shown()).toBe('CODING')
  // A call no rule names casts no vote.
  messages.push(did(use('ToolSearch', { query: 'x' }), use('SendMessage', { to: 'a', message: 'm' }), use('mcp__db__query', { sql: 's' })))
  await clock.advance(60_000)
  expect(await shown()).toBe('CODING')
  // One more look ties the last ten at five each.
  messages.push(did(READ))
  await clock.advance(60_000)
  expect(await shown()).toBe('RESEARCHING')
  await ui.unmount()
})

test('a failed check reads as debugging until a check passes', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT, use('Bash', { command: 'npm test' }))]
  engine(on, messages, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text

  // A check still running is testing; its failure shows at the next check, though the transcript reads the same.
  await clock.advance(60_000)
  expect(await shown()).toBe('TESTING')
  messages[0] = did(EDIT, use('Bash', { command: 'npm test' }, true))
  await clock.advance(60_000)
  expect(await shown()).toBe('DEBUGGING')
  // Looking and fixing after it is still debugging.
  messages.push(did(READ, EDIT, EDIT))
  await clock.advance(60_000)
  expect(await shown()).toBe('DEBUGGING')
  messages.push(did(use('Bash', { command: 'npm test' })))
  await clock.advance(60_000)
  expect(await shown()).toBe('CODING')
  await ui.unmount()
})

test('the goal sits pinned under what is happening now, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [did(EDIT)], () => say('**Now:** Adding a second summary.\n**Goal:** Make the box easy to read.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([
      'CODING',
      'Adding a second summary.',
      'GOAL',
      'Make the box easy to read.',
      'next check in 60s',
    ])
    expect((await ui.find({ type: 'Text', text: 'GOAL' }))?.props.bold).toBe(true)
    await ui.unmount()
  }
})

test('the goal holds until a reply names a new one', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'build a recap box', toolUses: [] }]
  const prompts: string[] = []
  const replies = [
    'Now: Working out the plan.\nGoal: Build a recap box.',
    // Each way a reply says the goal still fits: "same" ahead of the recap, no goal line, "none", and so on.
    'Goal: same\nNow: Writing the box.',
    'Now: Checking that the box works.',
    'Now: Checking it again.\nGoal: none',
    'Now: Fixing a slip.\n**Goal:** "same"',
    'Now: Nearly done.\nGoal: Unchanged.',
    'Now: Sharing it.\nGoal: Build a recap box and share it.',
  ]
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say(replies.shift() ?? '')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The recap, the goal's label and the goal, over the countdown.
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).slice(0, 3)

  await clock.advance(60_000)
  expect(await shown()).toEqual(['Working out the plan.', 'GOAL', 'Build a recap box.'])
  for (const now of ['Writing the box.', 'Checking that the box works.', 'Checking it again.', 'Fixing a slip.', 'Nearly done.']) {
    messages.push({ role: 'assistant', text: String(messages.length), toolUses: [] })
    await clock.advance(60_000)
    expect(await shown()).toEqual([now, 'GOAL', 'Build a recap box.'])
  }
  messages.push({ role: 'user', text: 'now share it', toolUses: [] })
  await clock.advance(60_000)
  expect(await shown()).toEqual(['Sharing it.', 'GOAL', 'Build a recap box and share it.'])
  await ui.unmount()

  // Each check is shown the goal it may keep.
  expect(prompts.map(p => p.split('\n')[0])).toEqual(['Goal so far: none', ...Array(6).fill('Goal so far: Build a recap box.')])
})

test("the goal reads the person's own prompts, the first and the newest eight", async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  engine(on, [{ role: 'user', text: 'one', toolUses: [] }], e => {
    prompts.push(e.prompt)

    return say('Now: Working.\nGoal: Answer the asks.')
  })
  const send = (text: string, origin: PromptOrigin = { kind: 'composer' }) => $.prompt.submit({ text, wait: false, origin })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // A setting changed first is no ask; a command that says what to do is.
  await $.prompt.submit({ text: '/effort max', wait: false, origin: { kind: 'composer' }, command: { name: 'effort', args: 'max' } })
  await send('ask\n  0')
  for (let n = 1; n <= 10; n++) {
    if (n === 5) await $.prompt.submit({ text: '/do ask 5', wait: false, origin: { kind: 'composer' }, command: { name: 'do', args: 'ask 5' } })
    else await send(`ask ${n}`)
  }
  // From a phone: still the person's words.
  await send('ask 11', { kind: 'bridge' })
  // A task's notice, another session's message and a prompt the person never saw are no asks.
  await send('a task finished', { kind: 'task-notification' })
  await send('hello from a peer', { kind: 'peer' })
  await $.prompt.submit({ text: 'hidden', wait: false, origin: { kind: 'composer' }, isMeta: true })
  await clock.advance(60_000)

  expect(prompts[0]?.match(/^- .*$/gm)).toEqual([
    '- ask 0',
    '- ask 4',
    '- /do ask 5',
    ...[6, 7, 8, 9, 10, 11].map(n => `- ask ${n}`),
  ])
})

test("an ask is what entered beneath, from the person's own origins alone", async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const entered = engine(on, [{ role: 'user', text: 'one', toolUses: [] }], e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })
  const sent: string[] = []
  const send = (text: string, origin: PromptOrigin, turnId?: string) => {
    sent.push(text)

    return $.prompt.submit({ text, wait: false, origin, ...(turnId && { turnId }) })
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await send('typed', { kind: 'composer' })
  await send('typed mid-turn', { kind: 'composer' }, 't1')
  await send('from the desktop app', { kind: 'sdk' })
  await send('from slack', { kind: 'slack-ping' })
  await send('by voice', { kind: 'plugin', name: 'voice', asUser: true })
  await send('a note of a plugin', { kind: 'plugin', name: 'notes' })
  // The stand-in masks the key in the first and drops the second, as a settings hook might; the sender sees which.
  expect((await send('my key is sk-live-123', { kind: 'composer' })).text).toBe('my key is [masked]')
  expect((await send('drop me', { kind: 'composer' })).drop).toBe('blocked')
  // Cut at 1200 through an emoji: the half left over is dropped, as the API refuses it.
  await send(`${'x'.repeat(1199)}😀 and more`, { kind: 'composer' })
  await clock.advance(60_000)

  // Each prompt went on to the hooks beneath.
  expect(entered).toEqual(sent)
  expect(prompts[0]?.match(/^- .*$/gm)).toEqual([
    '- typed',
    '- typed mid-turn',
    '- from the desktop app',
    '- from slack',
    '- by voice',
    '- my key is [masked]',
    `- ${'x'.repeat(1199)}`,
  ])
})
