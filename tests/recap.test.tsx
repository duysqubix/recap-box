import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type {
  AgentInfo,
  ModelCompleteInput,
  ModelCompleteResult,
  On,
  PromptOrigin,
  SessionEndInput,
  SessionMessage,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code'

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
const END: TurnCompleteInput = { answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' }

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
const sh = (command: string, isError?: true) => use('Bash', { command }, isError)

// The session's turn ends, and the check after it has run, past the gap between recaps.
const ends = async ($: Engine, clock: MockClock) => {
  await $.turn.complete(END)
  await clock.advance(10_000)
}
// A call of the session's, and the check after it.
const calls = async ($: Engine, clock: MockClock) => {
  await $.tool.call({ tool: 'Read', file_path: '/r/README.md' })
  await clock.advance(2_000)
}

// The store, the end of a session and whether the box is drawn, as a test may stand them in.
type Store = { get: (key: string) => unknown; set: (key: string, value: unknown) => unknown }
type Options = { agents?: AgentInfo[]; store?: Store; end?: () => Promise<void>; isPlaced?: () => boolean }

// Answers with what reached it; the prompt stand-in masks a key and drops a marked prompt, as a settings hook might.
const engine = (
  on: On,
  messages: SessionMessage[] | (() => Promise<SessionMessage[]>),
  model: (e: ModelCompleteInput) => Answer | Promise<Answer>,
  { agents = [], store = new Map(), end, isPlaced = () => true }: Options = {},
) => {
  const entered: string[] = []
  on('command.register', () => ({ value: { command: 'recap-box' } }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => ({ value: void store.set(e.key, e.value) }))
  // The box stays open until it is closed, and an open brings it back.
  let isOpen = false
  on('ui.open', () => {
    isOpen = true

    return { value: isPlaced() ? { isPlaced: true } : { isPlaced: false, reason: 'no surface' } }
  })
  on('ui.close', () => {
    isOpen = false

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'recap', title: 'Recap', isShown: true, isFocused: false, isPlaced: isPlaced() }] : [],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.end', async (_, e) => {
    await end?.()

    return { sessionId: e.sessionId }
  })
  on('session.messages', async () => ({ value: Array.isArray(messages) ? [...messages] : await messages() }))
  on('agent.list', () => ({ value: [...agents] }))
  on('model.complete', async (_, e) => model(e))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
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
  await ends($, clock)
  await ends($, clock)

  // Two turns, one change: one model call, reminders stripped.
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

test('the empty box waits in a theme color, on every surface', async ($, on) => {
  engine(on, [], () => ({ deny: 'nothing to recap' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const waiting = await ui.find({ type: 'Text', text: /Waiting/ })
    expect(waiting?.text).toBe('Waiting for activity.')
    expect(waiting?.props.color).toBe('inactive')
    await ui.unmount()
  }
})

test('a burst of events makes one check, two seconds after the last', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  let reads = 0
  const read = async () => {
    reads += 1

    return [...messages]
  }
  engine(on, read, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // The start's own check, for a transcript the session resumed.
  await clock.advance(2_000)
  expect(reads).toBe(1)

  for (let n = 0; n < 4; n++) {
    messages.push(did(READ))
    await $.tool.call({ tool: 'Read', file_path: '/r/README.md' })
    await clock.advance(1_500)
  }
  expect(reads).toBe(1)
  await clock.advance(500)
  expect(reads).toBe(2)
  // No event, no check.
  await clock.advance(60_000)
  expect(reads).toBe(2)
})

test("Haiku recaps at the end of the session's turn and at every fifth call, never at each call", async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  let asked = 0
  engine(on, messages, () => {
    asked += 1

    return say('Now: Working.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  // An empty transcript asks nothing.
  expect(asked).toBe(0)

  const edit = async () => {
    messages.push(did(EDIT))
    await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })
    await clock.advance(2_000)
  }
  for (let n = 0; n < 4; n++) await edit()
  expect(asked).toBe(0)
  await edit()
  expect(asked).toBe(1)
  // The count starts over at each recap.
  await clock.advance(10_000)
  for (let n = 0; n < 4; n++) await edit()
  expect(asked).toBe(1)

  messages.push({ role: 'assistant', text: 'Done.', toolUses: [] })
  await $.turn.complete(END)
  await clock.advance(2_000)
  expect(asked).toBe(2)

  // A helper's turn changes no recap.
  messages.push({ role: 'assistant', text: 'A helper reported.', toolUses: [] })
  await $.turn.start({ text: 'look', turnId: 'h1', agentId: 'a1' })
  await $.turn.complete({ ...END, turnId: 'h1', agentId: 'a1' })
  await clock.advance(30_000)
  expect(asked).toBe(2)
})

test('a recap due within ten seconds of the last waits for the gap, then reads the newest activity', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })

  // A resumed transcript is recapped at the start's own check, two seconds in.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(prompts.length).toBe(1)

  messages.push({ role: 'assistant', text: 'two', toolUses: [] })
  await $.turn.complete(END)
  await clock.advance(7_000)
  messages.push({ role: 'assistant', text: 'three', toolUses: [] })
  await clock.advance(2_900)
  expect(prompts.length).toBe(1)
  await clock.advance(100)
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('assistant: three')
})

test('an event while a check runs gets one more check once that one is done', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(READ)]
  // The transcript as it read when asked, handed back a while later.
  const read = async () => {
    const rows = [...messages]
    await clock.sleep(3_000)

    return rows
  }
  engine(on, read, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text

  // The start's check reads from two seconds in to five; an edit lands meanwhile, its check due at four and a half.
  await clock.advance(2_500)
  messages.push(did(EDIT))
  await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2_500)
  expect(await shown()).toBe('RESEARCHING')
  await clock.advance(3_000)
  expect(await shown()).toBe('CODING')
  await ui.unmount()
  // Every read and reply still asleep runs out before the test ends.
  await clock.advance(60_000)
})

test('a turn that ends while a check reads an older transcript still gets its recap', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  const read = async () => {
    const rows = [...messages]
    await clock.sleep(3_000)

    return rows
  }
  const prompts: string[] = []
  engine(on, read, e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })

  // The start's check reads from two seconds in to five; the turn ends meanwhile.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_500)
  messages.push({ role: 'assistant', text: 'the final answer', toolUses: [] })
  await $.turn.complete(END)
  await clock.advance(30_000)

  // The first recap read the older transcript; the turn's own came after it, past the gap.
  expect(prompts.length).toBe(2)
  expect(prompts[0]).not.toContain('the final answer')
  expect(prompts[1]).toContain('assistant: the final answer')
})

test('a /resume recaps the transcript it brings once the engine swaps it in, never the one it left', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(sh('git push')), { role: 'user', text: 'old work', toolUses: [] }]
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(2_000)
  expect(prompts.length).toBe(1)
  // The end returns before the engine swaps in the resumed transcript: the checks meanwhile read the old one.
  await $.session.end({ ...CLEAR, reason: 'resume' })
  await clock.advance(5_000)
  expect(prompts.length).toBe(1)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Waiting for activity.'])

  // The engine's SessionStart says the resumed transcript is in.
  messages.splice(0, messages.length, did(EDIT), { role: 'user', text: 'the resumed work', toolUses: [] })
  await $.classic.SessionStart({ source: 'resume' })
  await clock.advance(10_000)
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('user: the resumed work')
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('CODING')
  await ui.unmount()
})

test('a /resume whose transcript lands late is recapped by the retries alone', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'old work', toolUses: [] }]
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  await $.session.end({ ...CLEAR, reason: 'resume' })
  await clock.advance(7_000)
  messages.splice(0, messages.length, { role: 'user', text: 'the resumed work', toolUses: [] })
  await clock.advance(10_000)

  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('user: the resumed work')
  // The retries stop: with nothing new, nothing more reads.
  await clock.advance(60_000)
  expect(prompts.length).toBe(2)
})

test("a /resume that lands after the retries is recapped at the engine's SessionStart", async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'old work', toolUses: [] }]
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  await $.session.end({ ...CLEAR, reason: 'resume' })
  await clock.advance(30_000)
  messages.splice(0, messages.length, { role: 'user', text: 'the resumed work', toolUses: [] })
  await $.classic.SessionStart({ source: 'resume' })
  await clock.advance(15_000)

  expect(prompts.at(-1)).toContain('user: the resumed work')
})

test('a /clear, an exit or a logout schedules no check', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  const read = async () => {
    reads += 1

    return [did(EDIT)]
  }
  engine(on, read, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  for (const reason of ['clear', 'prompt_input_exit', 'logout', 'other'] as const) {
    const before = reads
    await $.session.end({ ...CLEAR, reason })
    await clock.advance(30_000)
    expect({ reason, reads: reads - before }).toEqual({ reason, reads: 0 })
  }
})

test('calls made while a check reads still count toward the next recap', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  const read = async () => {
    const rows = [...messages]
    await clock.sleep(3_000)

    return rows
  }
  let asked = 0
  engine(on, read, () => {
    asked += 1

    return say('Now: Working.')
  })
  const edit = async () => {
    messages.push(did(EDIT))
    await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  // A turn ends; its check reads from two seconds on to five, and three calls land meanwhile.
  messages.push({ role: 'assistant', text: 'Done.', toolUses: [] })
  await $.turn.complete(END)
  await clock.advance(2_500)
  for (let n = 0; n < 3; n++) await edit()
  await clock.advance(20_000)
  expect(asked).toBe(1)
  // Two more make five since that recap read.
  await edit()
  await edit()
  await clock.advance(20_000)
  expect(asked).toBe(2)
})

test('a steady stream of calls still gets its checks', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  const read = async () => {
    reads += 1

    return [did(READ)]
  }
  engine(on, read, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const before = reads
  // A helper's start every second and a half, each sooner than the two seconds a check waits.
  for (let n = 0; n < 20; n++) {
    await $.turn.start({ text: 'look', turnId: `h${n}`, agentId: 'a1' })
    await clock.advance(1_500)
  }
  // Put off five times at most, a check runs about every ten seconds of the stream.
  expect(reads - before).toBe(2)
  await clock.advance(60_000)
})

test('a box drawn at last checks the recap that came due while it waited', async ($, on) => {
  const clock = mock.clock(on)
  let isPlaced = false
  let asked = 0
  engine(
    on,
    [{ role: 'user', text: 'resume the work', toolUses: [] }],
    () => {
      asked += 1

      return say('Now: Picking the work back up.')
    },
    { isPlaced: () => isPlaced },
  )

  // Opened unasked on a narrow terminal, the box waits undrawn.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)
  expect(asked).toBe(0)
  // The terminal is widened: the box is drawn, with no new activity.
  isPlaced = true
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(2_000)
  expect(asked).toBe(1)
  expect((await ui.find({ type: 'Text', text: /Picking/ }))?.text).toBe('Picking the work back up.')
  // Its own writes draw it again, and schedule nothing more.
  await clock.advance(60_000)
  expect(asked).toBe(1)
  await ui.unmount()
})

test("a call during a check that must wait out the gap keeps its own check, not the gap's", async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT), { role: 'user', text: 'one', toolUses: [] }]
  const read = async () => {
    const rows = [...messages]
    await clock.sleep(1_000)

    return rows
  }
  engine(on, read, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text
  // The start's recap is asked at three; a turn ends then, and its check reads from five to six.
  await clock.advance(3_000)
  messages.push({ role: 'assistant', text: 'two', toolUses: [] })
  await $.turn.complete(END)
  await clock.advance(2_500)
  // A push lands while it reads: its own check is due at seven and a half, the gap's at thirteen.
  messages.push(did(sh('git push')))
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.advance(3_000)
  expect(await shown()).toBe('SHIPPING')
  await clock.advance(60_000)
  await ui.unmount()
})

test('a drawn box waiting out the gap reads the transcript only when it must', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT), { role: 'user', text: 'one', toolUses: [] }]
  let reads = 0
  const read = async () => {
    reads += 1

    return [...messages]
  }
  engine(on, read, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(2_000)
  // A turn ends right after a recap: its check at four waits for twelve, and each check's write draws the box again.
  messages.push({ role: 'assistant', text: 'two', toolUses: [] })
  await $.turn.complete(END)
  await clock.advance(10_000)
  expect(reads).toBe(3)
  await clock.advance(60_000)
  expect(reads).toBe(3)
  await ui.unmount()
})

test("a helper's calls ask for no recap, even while the session's own are due one", async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  const read = async () => {
    const rows = [...messages]
    await clock.sleep(3_000)

    return rows
  }
  let asked = 0
  engine(on, read, () => {
    asked += 1

    return say('Now: Working.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  // Five of the session's own calls ask for a recap; its check reads from two seconds on to five.
  for (let n = 0; n < 5; n++) {
    messages.push(did(EDIT))
    await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })
  }
  await clock.advance(2_500)
  // A helper's calls land while it reads.
  for (let n = 0; n < 3; n++) {
    messages.push(did(READ))
    await $.tool.call({ tool: 'Read', file_path: '/r/README.md', agentId: 'a1' } as Parameters<Engine['tool']['call']>[0])
  }
  await clock.advance(60_000)
  expect(asked).toBe(1)
})

test("a /clear drops the old conversation's pending check: nothing reads it while the end runs", async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  const read = async () => {
    reads += 1

    return [did(EDIT)]
  }
  const end = () => clock.sleep(5_000)
  engine(on, read, () => say('Now: Working.'), { end })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const before = reads
  // A call puts a check two seconds off; the /clear starts before then and takes five.
  await $.tool.call({ tool: 'Read', file_path: '/r/README.md' })
  const ending = $.session.end(CLEAR)
  await clock.advance(4_000)
  expect(reads).toBe(before)
  await clock.advance(1_000)
  await ending
  // Every read and reply still asleep runs out before the test ends.
  await clock.advance(60_000)
})

test('/recap-box hides the box, opens it and checks it; with words it says what it does', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })
  const run = async (args: string) =>
    (await $.command.run({ command: 'recap-box', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(prompts.length).toBe(1)

  // Opened, the box reads the stage again; with no turn over, it asks for no recap.
  messages.push(did(EDIT))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Shown since the start, the box hides, and shows again.
  expect(await run('')).toBe('Recap box closed.')
  expect(await run('')).toBe('Recap box opened.')
  await clock.advance(2_000)
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('CODING')
  expect(prompts.length).toBe(1)
  await ui.unmount()

  for (const args of ['update 30', 'faster', ' please ', 'history on']) {
    expect(await run(args)).toBe('/recap-box shows or hides the box; /recap-box history shows or hides its earlier recaps. It updates as the session works.')
  }

  // The box's own command asks for nothing: it is no part of the goal.
  await $.prompt.submit({ text: '/recap-box update 30', wait: false, origin: { kind: 'composer' }, command: { name: 'recap-box', args: 'update 30' } })
  await $.prompt.submit({ text: 'fix the login page', wait: false, origin: { kind: 'composer' } })
  messages.push({ role: 'user', text: 'two', toolUses: [] })
  await ends($, clock)
  expect(prompts.length).toBe(2)
  expect(prompts.at(-1)?.match(/^- .*$/gm)).toEqual(['- fix the login page'])
})

test('a store that cannot be read or written leaves the box at work', async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  const broken: Store = {
    get: () => {
      throw new Error('the store file is not JSON')
    },
    set: () => {
      throw new Error('the disk is full')
    },
  }
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  engine(
    on,
    messages,
    () => {
      calls += 1

      return say(`Now: Working ${calls}.`)
    },
    { store: broken },
  )
  const run = (args: string) =>
    $.command
      .run({ command: 'recap-box', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
      .then(() => 'saved', () => 'refused')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ends($, clock)
  expect(calls).toBe(1)
  // A save that fails changes nothing, not even for this session.
  expect(await run('history')).toBe('refused')
  messages.push({ role: 'assistant', text: 'two', toolUses: [] })
  await ends($, clock)
  expect(calls).toBe(2)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Working 2.'])
  await ui.unmount()
})

test('a refused model call says so in the box', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [{ role: 'user', text: 'hi', toolUses: [] }], () => ({ deny: 'model blocked' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ends($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No recap/ }))?.text).toContain('model blocked')
  await ui.unmount()
})

test('a start without a surface recaps once the desktop app attaches', async ($, on) => {
  const clock = mock.clock(on)
  let isPlaced = false
  let asked = 0
  engine(
    on,
    [{ role: 'user', text: 'resume the work', toolUses: [] }],
    () => {
      asked += 1

      return say('Now: Picking the work back up.')
    },
    { isPlaced: () => isPlaced },
  )

  // The desktop app, VS Code and mobile start this way, then attach.
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.advance(2_000)
  // Nothing draws the box yet: the recap stays due.
  expect(asked).toBe(0)
  isPlaced = true
  await $.session.attach({ surface: 'desktop', clientId: 'd1' })
  await clock.advance(2_000)
  expect(asked).toBe(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Picking/ }))?.text).toBe('Picking the work back up.')
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
  await ends($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(await shown()).toEqual(['CODING', 'Building it.', 'GOAL', 'A recap box.'])
  messages.length = 0
  await $.session.end(CLEAR)
  expect(await shown()).toEqual(['Waiting for activity.'])
  await ui.unmount()

  // The next conversation's first recap knows none of the old one's asks.
  messages.push({ role: 'user', text: 'two', toolUses: [] })
  await ends($, clock)
  expect(prompts.at(-2)).toContain('oldest first:\n- build a recap box\n')
  expect(prompts.at(-1)).toContain('oldest first:\nnone\n')
})

test('a /clear during a check keeps the old stage out of the new conversation', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT)]
  engine(on, messages, async () => {
    await clock.sleep(20_000)

    return say('Old talk.\nGoal: Old aim.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  // The stage shows while the recap is still being written, with no placeholder under it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['CODING'])
  messages.length = 0
  await $.session.end(CLEAR)
  await clock.advance(20_000)

  expect(await ui.find({ type: 'Text', text: /CODING|GOAL|Old aim/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toBe('Waiting for activity.')
  await ui.unmount()
  // Every read and reply still asleep runs out before the test ends.
  await clock.advance(60_000)
})

test('a check that starts while a /clear ends the conversation keeps the old one out', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(sh('git push'))]
  // The engine's end takes a moment, and until it is done messages() reads the old conversation.
  const end = async () => {
    await clock.sleep(3_000)
    messages.length = 0
  }
  // Its recap lands after the end is done.
  const model = async () => {
    await clock.sleep(3_000)

    return say('Now: Pushing the old work.\nGoal: The old aim.')
  }
  engine(on, messages, model, { end })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const ending = $.session.end(CLEAR)
  await clock.settle()
  // A turn ends while the end runs: its check, two seconds on, reads the old conversation.
  await $.turn.complete(END)
  await clock.advance(3_000)
  await ending
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Waiting for activity.'])
  await clock.advance(3_000)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Waiting for activity.'])
  await ui.unmount()
  // Every read and reply still asleep runs out before the test ends.
  await clock.advance(60_000)
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
  await clock.advance(2_000)
  await $.session.end(CLEAR)
  await clock.advance(5_000)

  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Waiting for activity.'])
  await ui.unmount()
  // Every read and reply still asleep runs out before the test ends.
  await clock.advance(60_000)
})

test('each kind of tool call names its stage', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  engine(on, messages, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const agent = (subagent_type: string, description: string) => use('Agent', { subagent_type, description, prompt: 'p' })
  const cases: [ToolUseSummary, string][] = [
    [use('Read', { file_path: '/r/README.md' }), 'RESEARCHING'],
    // A shell command goes by the commands it starts: quotes, arguments, file names and heredoc text run nothing.
    [sh('grep -n "git push origin" README.md'), 'RESEARCHING'],
    [sh('sed -n 1,9p tests/recap.test.tsx'), 'RESEARCHING'],
    [sh('cat logs/latest'), 'RESEARCHING'],
    [sh('test -f x || echo check && ls /tmp/test && command -v tsc'), 'RESEARCHING'],
    [sh('grep -rn "a && npm test" src'), 'RESEARCHING'],
    // A search that finds nothing exits with an error, and is still no failed test.
    [sh('grep -rn test src', true), 'RESEARCHING'],
    [sh("cat > notes.md <<'EOF'\n- check the pane\nnpm test\nelse: deploy\nEOF\nwc -l notes.md"), 'RESEARCHING'],
    [sh('sed -n 1,40p ~/.claude/scripts/ci-watch && bd create "Fix the deploy step"'), 'RESEARCHING'],
    // Reading a pull request or a CI run is a look.
    [sh('gh pr view 12 && gh run view 34 --log-failed'), 'RESEARCHING'],
    [use('Agent', { subagent_type: 'Plan', description: 'Plan the change', prompt: 'p' }), 'PLANNING'],
    [use('ExitPlanMode', {}), 'PLANNING'],
    [use('Skill', { skill: 'oh-my-claudecode:ralplan' }), 'PLANNING'],
    // An agent of no named kind goes by its task.
    [agent('general-purpose', 'Research the engine docs'), 'RESEARCHING'],
    // A task word inside another word names none: no stage, so the recap shows first.
    [agent('general-purpose', 'Retrace the latest release'), 'Working.'],
    [agent('general-purpose', 'Fix the critical bug'), 'Working.'],
    [EDIT, 'CODING'],
    // An agent of a named kind goes by its kind, whatever its task says.
    [agent('oh-my-claudecode:executor', 'Apply the review fixes from the plan to the tests'), 'CODING'],
    [sh('cd /r && claude plugin test .'), 'TESTING'],
    [sh('npm run test:unit'), 'TESTING'],
    [sh('npm run typecheck'), 'TESTING'],
    [sh('CI=1 timeout 300 ./node_modules/.bin/vitest run 2>&1 | tail -5'), 'TESTING'],
    [sh('yes | npm test'), 'TESTING'],
    [sh('python3 -m unittest discover'), 'TESTING'],
    [sh('cargo test', true), 'DEBUGGING'],
    // A run sent to the background answers when it starts, not how it ends.
    [use('Bash', { command: 'npm test', run_in_background: true }, true), 'TESTING'],
    [agent('oh-my-claudecode:code-reviewer', 'Review the diff'), 'REVIEWING'],
    [use('Skill', { skill: 'code-review' }), 'REVIEWING'],
    [use('Write', { file_path: '/r/README.md' }), 'WRITING'],
    [sh('git add -A && git commit -m "Pin the goal" && git push'), 'SHIPPING'],
    // Sending work out outranks the checks before it.
    [sh('npm test && git -C /r push'), 'SHIPPING'],
    [sh('~/.claude/scripts/ci-watch'), 'SHIPPING'],
    [agent('oh-my-claudecode:git-master', 'Commit and push'), 'SHIPPING'],
  ]
  for (const [call, stage] of cases) {
    await $.session.end(CLEAR)
    messages.splice(0, messages.length, did(call))
    await ends($, clock)
    expect({ call: call.input, shown: (await ui.findAll({ type: 'Text' }))[0]?.text }).toEqual({ call: call.input, shown: stage })
  }
  await ui.unmount()
})

test('the stage is the newest of the last five calls that does more than look', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT, sh('git commit -m x'), READ, READ, READ)]
  engine(on, messages, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text

  await clock.advance(2_000)
  expect(await shown()).toBe('SHIPPING')
  // A call no rule names casts no vote.
  messages.push(did(use('ToolSearch', { query: 'x' }), use('SendMessage', { to: 'a', message: 'm' }), use('mcp__db__query', { sql: 's' })))
  await calls($, clock)
  expect(await shown()).toBe('SHIPPING')
  // The commit is the fifth call back, then the sixth.
  messages.push(did(READ))
  await calls($, clock)
  expect(await shown()).toBe('SHIPPING')
  messages.push(did(READ))
  await calls($, clock)
  expect(await shown()).toBe('RESEARCHING')
  await ui.unmount()
})

test('a failed test run reads as debugging while it is among the last five calls', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT, sh('npm test'))]
  engine(on, messages, () => say('Now: Working.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text
  const after = async (...toolUses: ToolUseSummary[]) => {
    messages.push(did(...toolUses))
    await calls($, clock)

    return shown()
  }

  // A run still going is testing; its failure shows at the call's own check, though the transcript reads the same.
  await clock.advance(2_000)
  expect(await shown()).toBe('TESTING')
  messages[0] = did(EDIT, sh('npm test', true))
  await calls($, clock)
  expect(await shown()).toBe('DEBUGGING')
  // Looking and fixing after it is still debugging; a run that passes ends it.
  expect(await after(READ, EDIT, EDIT)).toBe('DEBUGGING')
  expect(await after(sh('npm test'))).toBe('TESTING')
  // A failure five calls back still shows; six calls back it is over.
  expect(await after(sh('npm test', true))).toBe('DEBUGGING')
  expect(await after(READ, READ, READ, READ)).toBe('DEBUGGING')
  expect(await after(READ)).toBe('RESEARCHING')
  // Piped to tail, a run exits 0 however it went: its output tells.
  const piped = (text: string) => ({ ...sh('cargo test 2>&1 | tail -20'), text })
  expect(await after(piped('test result: ok. 4 passed; 0 failed'))).toBe('TESTING')
  for (const failure of ['test result: FAILED. 3 passed; 1 failed', ' 2 failing', 'error[E0425]: cannot find value', 'src/a.ts(1,2): error TS2345: no', 'Validation failed']) {
    expect({ failure, shown: await after(piped(failure)) }).toEqual({ failure, shown: 'DEBUGGING' })
  }
  // A test agent's answer is its report, not a run's output.
  const tester = use('Agent', { subagent_type: 'oh-my-claudecode:test-engineer', description: 'Fix the tests', prompt: 'p' })
  expect(await after({ ...tester, text: 'Fixed the 2 failing tests.' })).toBe('TESTING')
  await ui.unmount()
})

test('a helper agent at work shows while the session waits on it or only looks', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT, READ), { role: 'assistant', text: 'Waiting on the review.', toolUses: [] }]
  const agents: AgentInfo[] = []
  let asked = 0
  engine(
    on,
    messages,
    () => {
      asked += 1

      return say('Now: Working.')
    },
    { agents },
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text
  // A helper's turn starting or ending: the stage is read again, and no recap is asked for.
  const helper = async (event: 'start' | 'complete', agentId: string) => {
    if (event === 'start') await $.turn.start({ text: 'look', turnId: `h-${agentId}`, agentId })
    else await $.turn.complete({ ...END, turnId: `h-${agentId}`, agentId })
    await clock.advance(2_000)
  }
  // Named by its kind: its task's words name no stage.
  const reviewer: AgentInfo = { id: 'a1', description: 'Second look at the diff', type: 'oh-my-claudecode:code-reviewer', status: 'running' }

  // A plugin's agent, one inside another agent, one not yet at work, and a teammate in a pane
  // of its own, whose status outlives the pane, are not the session's helpers.
  agents.push(
    { ...reviewer, id: 'a2', spawnedBy: 'notes' },
    { ...reviewer, id: 'a3', parentId: 'a1' },
    { ...reviewer, id: 'a5', status: 'pending' },
    { ...reviewer, id: 'w@team', teammateId: 'w@team' },
  )
  await clock.advance(2_000)
  expect(await shown()).toBe('CODING')
  // The start's own check recapped the resumed transcript; from here on, helpers ask for none.
  expect(asked).toBe(1)
  // It shows from its start, though the transcript reads the same.
  agents.push(reviewer)
  await helper('start', 'a1')
  expect(await shown()).toBe('REVIEWING')
  // Waiting on its own run, it is still at work.
  agents.splice(-1, 1, { ...reviewer, status: 'waiting' })
  await helper('complete', 'a1')
  expect(await shown()).toBe('REVIEWING')
  agents.splice(-1, 1, reviewer)
  // Back at work, the session's own calls show, and still once a call's result is the newest row.
  const look = use('Read', { file_path: '/r/README.md' })
  messages.push(did(look))
  await calls($, clock)
  expect(await shown()).toBe('CODING')
  messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: look.tool_use_id, text: 'one line', isError: false }] })
  await calls($, clock)
  expect(await shown()).toBe('CODING')
  // Once the last five calls only look, the helper's again.
  messages.push(did(READ, READ, READ, READ))
  await calls($, clock)
  expect(await shown()).toBe('REVIEWING')
  // A helper that is done shows no more.
  agents.splice(0, agents.length, { ...reviewer, status: 'completed' })
  await helper('complete', 'a1')
  expect(await shown()).toBe('RESEARCHING')
  // A helper of no named kind goes by its task.
  agents.push({ id: 'a4', description: 'Plan the release', type: 'general-purpose', status: 'running' })
  await helper('start', 'a4')
  expect(await shown()).toBe('PLANNING')
  expect(asked).toBe(1)
  await ui.unmount()
})

test('the goal sits pinned under what is happening now, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, [did(EDIT)], () => say('**Now:** Adding a second summary.\n**Goal:** Make the box easy to read.'))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ends($, clock)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([
      'CODING',
      'Adding a second summary.',
      'GOAL',
      'Make the box easy to read.',
    ])
    expect((await ui.find({ type: 'Text', text: 'GOAL' }))?.props.bold).toBe(true)
    // Every color a theme key, so the box follows the person's theme.
    expect((await ui.findAll({ type: 'Text' })).map(t => t.props.color)).toEqual([
      'claude',
      'text',
      'claude',
      'text',
    ])
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
    'Now: Tidying up.\nGoal: No changes.',
    'Now: Wrapping up.\nGoal: Still the same one.',
    'Now: Looking it over.\nGoal: none yet',
    'Now: Reading it again.\nGoal: Same goal as before.',
    'Now: Last touches.\nGoal: Unchanged from before.',
    // A goal that names "same" among other words is a new goal.
    'Now: Sharing it.\nGoal: Keep the same box.',
  ]
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say(replies.shift() ?? '')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The recap, the goal's label and the goal.
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)

  await ends($, clock)
  expect(await shown()).toEqual(['Working out the plan.', 'GOAL', 'Build a recap box.'])
  const nows = ['Writing the box.', 'Checking that the box works.', 'Checking it again.', 'Fixing a slip.', 'Nearly done.', 'Tidying up.', 'Wrapping up.', 'Looking it over.', 'Reading it again.', 'Last touches.']
  for (const now of nows) {
    messages.push({ role: 'assistant', text: String(messages.length), toolUses: [] })
    await ends($, clock)
    expect(await shown()).toEqual([now, 'GOAL', 'Build a recap box.'])
  }
  messages.push({ role: 'user', text: 'now share it', toolUses: [] })
  await ends($, clock)
  expect(await shown()).toEqual(['Sharing it.', 'GOAL', 'Keep the same box.'])
  await ui.unmount()

  // Each recap is shown the goal it may keep.
  expect(prompts.map(p => p.split('\n')[0])).toEqual(['Goal so far: none', ...Array(11).fill('Goal so far: Build a recap box.')])
})

test("the goal reads the person's own prompts, the first and the newest eight", async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const messages: SessionMessage[] = []
  engine(on, messages, e => {
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
  messages.push({ role: 'user', text: 'one', toolUses: [] })
  await ends($, clock)

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
  const messages: SessionMessage[] = []
  const entered = engine(on, messages, e => {
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
  messages.push({ role: 'user', text: 'one', toolUses: [] })
  await ends($, clock)

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

test('with history on, the earlier recaps run under the recap and goal, the newest first, under the stage each was written in', async ($, on) => {
  const clock = mock.clock(on)
  const store = new Map<string, unknown>()
  const messages: SessionMessage[] = [did(READ)]
  const replies = ['Now: Reading the code.\nGoal: Add a history.', 'Now: Changing the box.', 'Now: Changing the box.', 'Now: Checking the box.']
  engine(on, messages, () => say(replies.shift() ?? ''), { store })
  const run = async (args: string) =>
    (await $.command.run({ command: 'recap-box', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ends($, clock)
  messages.push(did(EDIT))
  await ends($, clock)
  // The same recap again adds no entry.
  messages.push(did(EDIT))
  await ends($, clock)
  messages.push(did(sh('npm test')))
  await ends($, clock)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // Off, as a first session starts: the latest recap alone.
    expect(await shown()).toEqual(['TESTING', 'Checking the box.', 'GOAL', 'Add a history.'])
    expect(await run('history')).toBe(
      'The box lists its earlier recaps under the goal, the newest first. Scroll down in it for older ones, or press ctrl+x tab, then the down arrow, and Page Up to go back.',
    )
    expect(store.get('history')).toBe(true)
    expect(await shown()).toEqual([
      'TESTING',
      'Checking the box.',
      'GOAL',
      'Add a history.',
      'CODING',
      'Changing the box.',
      'RESEARCHING',
      'Reading the code.',
    ])
    // The earlier recaps are dimmed under their stage's color, in theme keys; the one on show stands out.
    expect((await ui.find({ type: 'Text', text: 'CODING' }))?.props).toEqual({ color: 'claude' })
    expect((await ui.find({ type: 'Text', text: 'Changing the box.' }))?.props).toEqual({ color: 'inactive' })
    expect((await ui.find({ type: 'Text', text: 'TESTING' }))?.props).toMatchObject({ bold: true, color: 'autoAccept' })
    expect(await run(' HISTORY ')).toBe('The box shows the latest recap only.')
    expect(store.get('history')).toBe(false)
    expect(await shown()).toEqual(['TESTING', 'Checking the box.', 'GOAL', 'Add a history.'])
    await ui.unmount()
  }
})

for (const [kept, isShown] of [[true, true], ['true', false], [1, false]] as const) {
  test(`a session starts with the history ${isShown ? 'shown' : 'hidden'} when the kept value is ${JSON.stringify(kept)}, and a /clear empties it`, async ($, on) => {
    const clock = mock.clock(on)
    const messages: SessionMessage[] = [did(READ)]
    const replies = ['Now: First.', 'Now: Second.', 'Now: Third.']
    engine(on, messages, () => say(replies.shift() ?? ''), { store: new Map<string, unknown>([['history', kept]]) })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ends($, clock)
    messages.push(did(EDIT))
    await ends($, clock)
    expect(await shown()).toEqual(isShown ? ['CODING', 'Second.', 'RESEARCHING', 'First.'] : ['CODING', 'Second.'])

    // The next conversation's history starts with its own first recap.
    messages.splice(0, messages.length, did(sh('npm test')))
    await $.session.end(CLEAR)
    expect(await shown()).toEqual(['Waiting for activity.'])
    await ends($, clock)
    expect(await shown()).toEqual(['TESTING', 'Third.'])
    await ui.unmount()
  })
}

test("the history keeps the newest 200 recaps, and the person's place as the oldest drops", async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  let n = 0
  engine(on, messages, () => say(`Now: Recap ${++n}.`), { store: new Map<string, unknown>([['history', true]]) })
  on('ui.scroll', () => ({}))
  const check = async () => {
    messages.push({ role: 'assistant', text: String(n), toolUses: [] })
    await ends($, clock)
  }
  // A live surface draws as each write lands, so a place moved after one must draw again.
  let isDrawn = false
  on('state.set', async (_, e, next) => {
    const r = await next(e)
    if (isDrawn) await ui.findAll({ type: 'Text' })

    return r
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 201; i++) await check()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  isDrawn = true
  // How many lines show, the first two and the last.
  const edges = async () => {
    const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)

    return [shown.length, shown[0], shown[1], shown.at(-1)]
  }
  expect(await edges()).toEqual([200, 'Recap 201.', 'Recap 200.', 'Recap 2.'])

  // A tick down passes Recap 200; the next recap drops Recap 2, and the box still starts from Recap 199.
  await $.ui.scroll({ component: 'Pane', requestId: 'recap', offset: 1, by: 1, bodyRows: 20, contentRows: 40, origin: { kind: 'person' }, pointer: { column: 5, row: 15 } })
  await check()
  expect(await edges()).toEqual([198, 'Recap 202.', 'Recap 199.', 'Recap 3.'])
  // At the oldest, End's place, the next drop leaves the box on the new oldest.
  await $.ui.scroll({ component: 'Pane', requestId: 'recap', offset: 20, by: 40, bodyRows: 20, contentRows: 40, origin: { kind: 'person' } })
  await check()
  expect(await edges()).toEqual([2, 'Recap 203.', 'Recap 4.', 'Recap 4.'])
  await ui.unmount()
})

test('a scroll that reads the history while a /clear ends the conversation leaves the next one at its newest', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  let n = 0
  engine(on, messages, () => say(`Now: Recap ${++n}.`), { store: new Map<string, unknown>([['history', true]]) })
  on('ui.scroll', () => ({}))
  // The scroll's read of the history takes a moment, and the /clear lands in it.
  let onRead: (() => void) | undefined
  on('state.get', async (_, e, next) => {
    const r = await next(e)
    if (onRead && e.key === 'history') {
      onRead()
      onRead = undefined
      await clock.sleep(5_000)
    }

    return r
  })
  const check = async () => {
    messages.push({ role: 'assistant', text: String(n), toolUses: [] })
    await ends($, clock)
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 5; i++) await check()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const isRead = new Promise<void>(resolve => (onRead = () => resolve()))
  const moving = $.ui.scroll({ component: 'Pane', requestId: 'recap', offset: 1, by: 1, bodyRows: 20, contentRows: 40, origin: { kind: 'person' }, pointer: { column: 5, row: 15 } })
  await isRead
  await $.session.end(CLEAR)
  await clock.advance(5_000)
  await moving

  // The old conversation's place stays out: the box follows the new one's recaps from the newest.
  for (let i = 0; i < 8; i++) await check()
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([13, 12, 11, 10, 9, 8, 7, 6].map(k => `Recap ${k}.`))
  await ui.unmount()
})

// The kit has no window: whether the recap and goal stay in view as the box scrolls is checked in a live session.
test('the wheel and the keys move the earlier recaps under the recap and goal, and the window stays at the top', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = []
  let n = 0
  engine(on, messages, () => say(`Now: Recap ${++n}.\nGoal: Read the box.`))
  const moves: unknown[] = []
  on('ui.scroll', (_, e) => {
    moves.push(e)

    return {}
  })
  const run = (args: string) =>
    $.command.run({ command: 'recap-box', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const check = async () => {
    messages.push({ role: 'assistant', text: String(n), toolUses: [] })
    await ends($, clock)
  }
  // The person's moves as the engine raises them from the top, over a tree taller than the box unless told: a wheel
  // tick down or up, or the rows a key asks for (an arrow one, a page key the box's 20, Home and End the tree's 40).
  const move = (by: number, contentRows: number, isWheel: boolean) =>
    $.ui.scroll({
      component: 'Pane',
      requestId: 'recap',
      offset: Math.max(by, 0),
      by,
      bodyRows: 20,
      contentRows,
      origin: { kind: 'person' },
      ...(isWheel && { pointer: { column: 5, row: 15 } }),
    })
  const wheel = (by: number, contentRows = 40) => move(by, contentRows, true)
  const key = (by: number, contentRows = 40) => move(by, contentRows, false)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 4; i++) await check()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async (at = ui) => (await at.findAll({ type: 'Text' })).map(t => t.text)
  const PINNED = ['GOAL', 'Read the box.']
  const ALL = ['Recap 5.', ...PINNED, 'Recap 4.', 'Recap 3.', 'Recap 2.', 'Recap 1.']

  // With the history off, the engine moves the window as it came.
  const tick = { component: 'Pane', requestId: 'recap', offset: 1, by: 1, bodyRows: 20, contentRows: 40, origin: { kind: 'person' }, pointer: { column: 5, row: 15 } } as const
  expect(await $.ui.scroll(tick)).toEqual({})
  expect(moves.at(-1)).toEqual(tick)

  await run('history')
  expect(await shown()).toEqual(['Recap 4.', ...PINNED, 'Recap 3.', 'Recap 2.', 'Recap 1.'])
  // A tick down passes the newest earlier recap, and the window stays at the top.
  expect(await wheel(1)).toEqual({})
  expect(moves.at(-1)).toMatchObject({ offset: 0, by: 1 })
  expect(await shown()).toEqual(['Recap 4.', ...PINNED, 'Recap 2.', 'Recap 1.'])
  // Never past the oldest, nor down once what is left fits the box, though up from there.
  await wheel(10)
  expect(await shown()).toEqual(['Recap 4.', ...PINNED, 'Recap 1.'])
  await wheel(-1, 20)
  await wheel(1, 20)
  expect(await shown()).toEqual(['Recap 4.', ...PINNED, 'Recap 2.', 'Recap 1.'])
  // A new recap keeps the person's place.
  await check()
  expect(await shown()).toEqual(['Recap 5.', ...PINNED, 'Recap 2.', 'Recap 1.'])
  // Never above the newest.
  await wheel(-10)
  expect(await shown()).toEqual(ALL)

  // An arrow or a page key moves one recap; Home and End go to the newest and the oldest.
  await key(1)
  await key(20)
  expect(await shown()).toEqual(['Recap 5.', ...PINNED, 'Recap 2.', 'Recap 1.'])
  await key(-20)
  expect(await shown()).toEqual(['Recap 5.', ...PINNED, 'Recap 3.', 'Recap 2.', 'Recap 1.'])
  await key(40)
  expect(await shown()).toEqual(['Recap 5.', ...PINNED, 'Recap 1.'])
  // Where what is left just fills the box, a page key asks for as many rows as Home would, and still moves one.
  await key(-20, 20)
  expect(await shown()).toEqual(['Recap 5.', ...PINNED, 'Recap 2.', 'Recap 1.'])
  await key(-40)
  expect(await shown()).toEqual(ALL)

  // Opened or turned on again, the history starts from the newest, and so does the next conversation's. The box is
  // shown, so /recap-box first hides it.
  await key(1)
  expect((await run('')).text).toBe('Recap box closed.')
  expect((await run('')).text).toBe('Recap box opened.')
  expect(await shown()).toEqual(ALL)
  await key(1)
  await run('history')
  await run('history')
  expect(await shown()).toEqual(ALL)
  await key(40)
  await $.session.end(CLEAR)
  for (let i = 0; i < 3; i++) await check()
  expect(await shown()).toEqual(['Recap 8.', ...PINNED, 'Recap 7.', 'Recap 6.'])

  // Drawn inline on another surface too, the box shows them all there, and the terminal's dock still holds its recap
  // and goal as it scrolls.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'inline' } })
  const onDesk = async () => (await desk.findAll({ type: 'Text' })).map(t => t.text)
  expect(await onDesk()).toEqual(['Recap 8.', ...PINNED, 'Recap 7.', 'Recap 6.'])
  await wheel(1)
  expect(moves.at(-1)).toMatchObject({ offset: 0 })
  expect(await shown()).toEqual(['Recap 8.', ...PINNED, 'Recap 6.'])
  expect(await onDesk()).toEqual(['Recap 8.', ...PINNED, 'Recap 7.', 'Recap 6.'])
  await desk.unmount()

  // Inline above the prompt in the terminal, where the box is short, it shows them all and its window scrolls as it came.
  await ui.unmount()
  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } })
  expect(await shown(inline)).toEqual(['Recap 8.', ...PINNED, 'Recap 7.', 'Recap 6.'])
  expect(await $.ui.scroll(tick)).toEqual({})
  expect(moves.at(-1)).toEqual(tick)
  await inline.unmount()
})

test('with history on, a refused model call shows in the recap\'s place and stays out of the history', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(READ)]
  const replies: Answer[] = [say('Now: First.'), { deny: 'model blocked' }, say('Now: Third.')]
  engine(on, messages, () => replies.shift() ?? say(''), { store: new Map<string, unknown>([['history', true]]) })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ends($, clock)
  messages.push(did(EDIT))
  await ends($, clock)
  expect(await shown()).toEqual(['CODING', expect.stringContaining('model blocked'), 'RESEARCHING', 'First.'])
  messages.push(did(sh('npm test')))
  await ends($, clock)
  expect(await shown()).toEqual(['TESTING', 'Third.', 'RESEARCHING', 'First.'])
  await ui.unmount()
})
