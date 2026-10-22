import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, SessionEndInput, SessionMessage } from 'claude-code'

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

const engine = (on: On, messages: SessionMessage[], model: (e: ModelCompleteInput) => Answer | Promise<Answer>) => {
  on('command.register', () => ({ value: { command: 'recap-box' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'recap', title: 'Recap', isShown: true, isFocused: false, isPlaced: true }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.messages', () => ({ value: [...messages] }))
  on('model.complete', async (_, e) => model(e))
}

test('the box recaps new activity once, with its stage, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: ' Coding.\n Building a\n recap mod.\x1b ', usage: USAGE } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  messages.push({ role: 'user', text: 'make a recap box <system-reminder>noise</system-reminder>', toolUses: [] })
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

  // A reply without a stage line is all recap.
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

test('a /clear drops the stage with the recap', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  engine(on, messages, () => say('Coding\nBuilding it.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /CODING/ }))?.text).toBe('CODING')
  messages.length = 0
  await $.session.end(CLEAR)
  expect(await ui.find({ type: 'Text', text: /CODING/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toBe('Waiting for activity.')
  await ui.unmount()
})

test('a /clear during a check keeps the old stage out of the new conversation', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  engine(on, messages, async () => {
    await clock.sleep(20_000)

    return say('Coding\nOld talk.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  messages.length = 0
  await $.session.end(CLEAR)
  await clock.advance(20_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /CODING/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toBe('Waiting for activity.')
  await ui.unmount()
})

test('a stage-only reply moves the stage and keeps the recap', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  const replies = ['Testing\nRunning the suite.', 'Debugging']
  engine(on, messages, () => say(replies.shift() ?? ''))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  messages.push({ role: 'assistant', text: 'two', toolUses: [] })
  await clock.advance(60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /DEBUGGING/ }))?.text).toBe('DEBUGGING')
  expect((await ui.find({ type: 'Text', text: /Running/ }))?.text).toBe('Running the suite.')
  await ui.unmount()
})

test('a closing one-word line that names no stage stays out of the recap', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ role: 'user', text: 'one', toolUses: [] }], () => say('wrapping\nThe session has ended.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /session has ended/ }))?.text).toBe('The session has ended.')
  await ui.unmount()
})
