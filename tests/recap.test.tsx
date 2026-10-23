import { expect, mock, test } from 'claude-code/testing'
import type {
  AgentInfo,
  ModelCompleteInput,
  ModelCompleteResult,
  On,
  PromptOrigin,
  SessionEndInput,
  SessionMessage,
  ToolUseSummary,
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

// Answers with what reached it; the prompt stand-in masks a key and drops a marked prompt, as a settings hook might.
const engine = (
  on: On,
  messages: SessionMessage[] | (() => Promise<SessionMessage[]>),
  model: (e: ModelCompleteInput) => Answer | Promise<Answer>,
  agents: AgentInfo[] = [],
  store = new Map<string, unknown>(),
) => {
  const entered: string[] = []
  on('command.register', () => ({ value: { command: 'recap-box' } }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => ({ value: void store.set(e.key, e.value) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'recap', title: 'Recap', isShown: true, isFocused: false, isPlaced: true }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.messages', async () => ({ value: Array.isArray(messages) ? [...messages] : await messages() }))
  on('agent.list', () => ({ value: [...agents] }))
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

test('/recap-box update sets the seconds between checks, and later sessions keep them', async ($, on) => {
  const clock = mock.clock(on)
  const store = new Map<string, unknown>()
  const messages: SessionMessage[] = [{ role: 'user', text: 'one', toolUses: [] }]
  let calls = 0
  engine(
    on,
    messages,
    () => {
      calls += 1

      return say('Now: Working.')
    },
    [],
    store,
  )
  const run = async (args: string) =>
    (await $.command.run({ command: 'recap-box', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const countdown = async () => (await ui.find({ type: 'Text', text: /next check/ }))?.text

  // Mid-count, the count starts over at the new length.
  await clock.advance(5_000)
  expect(await run('update 20')).toBe('The box checks every 20s.')
  expect(await countdown()).toBe('next check in 20s')
  await clock.advance(19_000)
  expect(calls).toBe(0)
  await clock.advance(1_000)
  expect(calls).toBe(1)
  expect(await countdown()).toBe('next check in 20s')

  // Out of range or no number changes nothing.
  for (const args of ['update 9', 'update 3601', 'update soon', 'update', 'faster', 'please update 30']) {
    expect(await run(args)).toBe('Usage: /recap-box update <seconds>, from 10 to 3600. The box checks every 20s.')
  }
  expect(await run(' UPDATE 3600s ')).toBe('The box checks every 3600s.')
  expect(await run('update 10')).toBe('The box checks every 10s.')
  expect(store.get('every')).toBe(10)
  expect(await run('')).toBe('Recap box opened.')

  // A later session, or a reload, starts at the kept length.
  await clock.advance(3_000)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await countdown()).toBe('next check in 10s')
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
    await clock.advance(60_000)
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

  await clock.advance(60_000)
  expect(await shown()).toBe('SHIPPING')
  // A call no rule names casts no vote.
  messages.push(did(use('ToolSearch', { query: 'x' }), use('SendMessage', { to: 'a', message: 'm' }), use('mcp__db__query', { sql: 's' })))
  await clock.advance(60_000)
  expect(await shown()).toBe('SHIPPING')
  // The commit is the fifth call back, then the sixth.
  messages.push(did(READ))
  await clock.advance(60_000)
  expect(await shown()).toBe('SHIPPING')
  messages.push(did(READ))
  await clock.advance(60_000)
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
    await clock.advance(60_000)

    return shown()
  }

  // A run still going is testing; its failure shows at the next check, though the transcript reads the same.
  await clock.advance(60_000)
  expect(await shown()).toBe('TESTING')
  messages[0] = did(EDIT, sh('npm test', true))
  await clock.advance(60_000)
  expect(await shown()).toBe('DEBUGGING')
  // Looking and fixing after it is still debugging; a run that passes ends it.
  expect(await after(READ, EDIT, EDIT)).toBe('DEBUGGING')
  expect(await after(sh('npm test'))).toBe('TESTING')
  // A failure five calls back still shows; six calls back it is over.
  expect(await after(sh('npm test', true))).toBe('DEBUGGING')
  expect(await after(READ, READ, READ, READ)).toBe('DEBUGGING')
  expect(await after(READ)).toBe('RESEARCHING')
  await ui.unmount()
})

test('a helper agent at work shows while the session waits on it or only looks', async ($, on) => {
  const clock = mock.clock(on)
  const messages: SessionMessage[] = [did(EDIT, READ), { role: 'assistant', text: 'Waiting on the review.', toolUses: [] }]
  const agents: AgentInfo[] = []
  engine(on, messages, () => say('Now: Working.'), agents)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = async () => (await ui.findAll({ type: 'Text' }))[0]?.text
  // Named by its kind: its task's words name no stage.
  const reviewer: AgentInfo = { id: 'a1', description: 'Second look at the diff', type: 'oh-my-claudecode:code-reviewer', status: 'running' }

  // A plugin's agent, or one inside another agent, is not the session's helper.
  agents.push({ ...reviewer, id: 'a2', spawnedBy: 'notes' }, { ...reviewer, id: 'a3', parentId: 'a1' })
  await clock.advance(60_000)
  expect(await shown()).toBe('CODING')
  // It shows from the check after it starts, though the transcript reads the same.
  agents.push(reviewer)
  await clock.advance(60_000)
  expect(await shown()).toBe('REVIEWING')
  // Back at work, the session's own calls show, and still once a call's result is the newest row.
  const look = use('Read', { file_path: '/r/README.md' })
  messages.push(did(look))
  await clock.advance(60_000)
  expect(await shown()).toBe('CODING')
  messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: look.tool_use_id, text: 'one line', isError: false }] })
  await clock.advance(60_000)
  expect(await shown()).toBe('CODING')
  // Once the last five calls only look, the helper's again.
  messages.push(did(READ, READ, READ, READ))
  await clock.advance(60_000)
  expect(await shown()).toBe('REVIEWING')
  // A helper that is done shows no more.
  agents.splice(0, agents.length, { ...reviewer, status: 'completed' })
  await clock.advance(60_000)
  expect(await shown()).toBe('RESEARCHING')
  // A helper of no named kind goes by its task.
  agents.push({ id: 'a4', description: 'Plan the release', type: 'general-purpose', status: 'running' })
  await clock.advance(60_000)
  expect(await shown()).toBe('PLANNING')
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
    'Now: Tidying up.\nGoal: No changes.',
    'Now: Wrapping up.\nGoal: Still the same one.',
    // Past four words, a goal that names "same" is a new goal.
    'Now: Sharing it.\nGoal: Share the same box everywhere.',
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
  const nows = ['Writing the box.', 'Checking that the box works.', 'Checking it again.', 'Fixing a slip.', 'Nearly done.', 'Tidying up.', 'Wrapping up.']
  for (const now of nows) {
    messages.push({ role: 'assistant', text: String(messages.length), toolUses: [] })
    await clock.advance(60_000)
    expect(await shown()).toEqual([now, 'GOAL', 'Build a recap box.'])
  }
  messages.push({ role: 'user', text: 'now share it', toolUses: [] })
  await clock.advance(60_000)
  expect(await shown()).toEqual(['Sharing it.', 'GOAL', 'Share the same box everywhere.'])
  await ui.unmount()

  // Each check is shown the goal it may keep.
  expect(prompts.map(p => p.split('\n')[0])).toEqual(['Goal so far: none', ...Array(8).fill('Goal so far: Build a recap box.')])
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
