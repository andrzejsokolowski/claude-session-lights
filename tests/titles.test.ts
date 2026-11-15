import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test runner has timers; the hooks' own lib (no DOM) doesn't declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

// Lets the work a hook left running (renames, writes) finish.
const settle = () => new Promise<void>(done => setTimeout(done, 30))

// Claude's own call of an MCP tool, which the built-in tools' table doesn't type.
type LooseCall = (input: Record<string, unknown>) => Promise<unknown>

/**
 * The app beneath the mod: get_session reads the title, set_session_title renames it. While
 * the name is hand-typed, the app either refuses the mod's rename (`refuse`) or holds it for an
 * approval card it never shows (`hang`); Claude's own rename (a tool call) goes through, as the
 * person approved its card. `isSlow` makes the mod's wait for an answer end at once.
 */
function app(on: On, handNamed: 'refuse' | 'hang') {
  const chat = { title: 'Release notes', isHandNamed: true }
  const store = new Map<string, unknown>()
  const text = (t: string) => [{ type: 'text' as const, text: t }]

  on('mcp.call', (_, e) => {
    if (e.tool === 'get_session') {
      return { value: { content: text(JSON.stringify({ title: chat.title })), isError: false } }
    }
    if (e.tool === 'set_session_title') {
      if (chat.isHandNamed && handNamed === 'hang') return new Promise<never>(() => undefined)
      if (chat.isHandNamed) return { value: { content: text('the user set this title'), isError: true } }
      chat.title = String(e.args.title)
      return { value: { content: text('renamed'), isError: false } }
    }
    return { value: { content: text('no such tool'), isError: true } }
  })
  // A hanging call loses the race at once; an answered one wins before the wait ends.
  on('clock.sleep', () =>
    handNamed === 'hang'
      ? { value: undefined }
      : new Promise(done => setTimeout(() => done({ value: undefined }), 1_000)),
  )
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('env.get', () => ({ value: 'C:/home' }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.root', () => ({ value: 'C:/Projects/demo' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'lights' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context ?? [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    const input = e as unknown as Record<string, unknown>
    chat.title = String(input.title)
    chat.isHandNamed = false // the person approved Claude's rename: the name is no longer theirs
    return { result: {}, text: 'renamed' }
  })
  return chat
}

for (const handNamed of ['refuse', 'hang'] as const) {
  test(`a hand-named chat (the app ${handNamed}s): Claude asked once, then dots`, async ($, on) => {
    const chat = app(on, handNamed)

    await $.session.start({ cwd: 'C:/Projects/demo', surface: 'desktop', isInteractive: true })
    await settle()
    expect(chat.title).toBe('Release notes') // the mod's own rename did not go through

    const first = await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
    const notes = 'context' in first ? (first.context ?? []) : []
    expect(notes.join('\n')).toContain('"🟢 Release notes"')

    const second = await $.prompt.submit({ text: 'again', origin: { kind: 'composer' }, wait: false })
    expect('context' in second ? (second.context ?? []).join('') : '').not.toContain('session-lights')

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await ($.tool.call as unknown as LooseCall)({
      tool: 'mcp__ccd_session_mgmt__set_session_title',
      session_id: 'self',
      title: '🟢 Release notes',
    })
    expect(chat.title).toBe('🟢 Release notes')

    await $.turn.complete({ answer: 'All done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
    await settle()
    expect(chat.title).toBe('⚪ Release notes') // from here the mod renames it by itself
  })
}
