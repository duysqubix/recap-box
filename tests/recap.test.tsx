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

// The end of a session and whether the box is drawn, as a test may stand them in.
type Options = { agents?: AgentInfo[]; end?: () => Promise<void>; isPlaced?: () => boolean }

// Answers with what reached it; the prompt stand-in masks a key and drops a marked prompt, as a settings hook might.
const engine = (
  on: On,
  messages: SessionMessage[] | (() => Promise<SessionMessage[]>),
  model: (e: ModelCompleteInput) => Answer | Promise<Answer>,
  { agents = [], end, isPlaced = () => true }: Options = {},
) => {
  const entered: string[] = []
  on('command.register', () => ({ value: { command: 'recap-box' } }))
  on('ui.open', () => ({ value: isPlaced() ? { isPlaced: true } : { isPlaced: false, reason: 'no surface' } }))
  on('ui.panes', () => ({ value: [{ id: 'recap', title: 'Recap', isShown: true, isFocused: false, isPlaced: isPlaced() }] }))
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

test('a /resume recaps the transcript it brings, with no new activity', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [{ role: 'user', text: 'old work', toolUses: [] }]
  const prompts: string[] = []
  engine(on, messages, e => {
    prompts.push(e.prompt)

    return say('Now: Working.')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(prompts.length).toBe(1)
  messages.splice(0, messages.length, { role: 'user', text: 'the resumed work', toolUses: [] })
  await $.session.end({ ...CLEAR, reason: 'resume' })
  await clock.advance(10_000)

  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('user: the resumed work')
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
})

test('/recap-box opens the box and checks it; with words it says what it does', async ($, on) => {
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
  expect(await run('')).toBe('Recap box opened.')
  await clock.advance(2_000)
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('CODING')
  expect(prompts.length).toBe(1)
  await ui.unmount()

  for (const args of ['update 30', 'faster', ' please ']) {
    expect(await run(args)).toBe('/recap-box opens the box. It updates as the session works.')
  }

  // The box's own command asks for nothing: it is no part of the goal.
  await $.prompt.submit({ text: '/recap-box update 30', wait: false, origin: { kind: 'composer' }, command: { name: 'recap-box', args: 'update 30' } })
  await $.prompt.submit({ text: 'fix the login page', wait: false, origin: { kind: 'composer' } })
  messages.push({ role: 'user', text: 'two', toolUses: [] })
  await ends($, clock)
  expect(prompts.length).toBe(2)
  expect(prompts.at(-1)?.match(/^- .*$/gm)).toEqual(['- fix the login page'])
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

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([
      'CODING',
      'Adding a second summary.',
      'GOAL',
      'Make the box easy to read.',
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
