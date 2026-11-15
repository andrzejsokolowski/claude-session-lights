import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LightColor, LightRow, LightSelf, LightWaiter } from '../types'

// Every session that loads this mod writes its light to <config>/session-lights/<id>.json;
// the pane reads the folder and lists every session's light.

const PANE = 'session-lights'
const TITLE = 'Session lights'
const BEAT_MS = 20_000 // each session rewrites its file this often
const POLL_MS = 2_000 // the open pane re-reads the folder this often
const STALE_MS = 75_000 // no heartbeat for this long: the session's process is gone
const KEEP_MS = 3 * 24 * 3_600_000 // files untouched for longer are not listed
const WAITER_MAX_MS = 12 * 3_600_000 // a background wait older than this is dropped

const COLOR: Record<LightColor, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  grey: '#9ca3af',
}
const RANK: Record<LightColor, number> = { red: 0, yellow: 1, green: 2, grey: 3 }
const LABEL: Record<LightColor, string> = {
  green: 'working',
  yellow: 'waiting',
  red: 'needs you',
  grey: 'done',
}

const INITIAL: LightSelf = {
  title: '',
  project: '',
  light: 'grey',
  why: 'new session',
  since: 0,
  asked: '',
  isTurn: false,
  waiters: [],
}
const self = atom({ plugin: 'session-lights', key: 'self' } as const, INITIAL, { shape: 'self-2' })
const board = atom({ plugin: 'session-lights', key: 'board' } as const, [] as LightRow[], {
  shape: 'board-1',
})

type Dollar = EngineInterface

// Every hook here only watches. If one fails, the engine goes on as if the mod weren't here
// (after a `next` already called, `next(e)` replays what it settled to; nothing runs twice).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const passThrough = (_$: unknown, e: any, next: (e: any) => any) => next(e)

let lastBoardWrite = 0

async function lightsDir($: Dollar): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const base = config ?? `${home.replace(/[\\/]+$/, '')}/.claude`
  return `${base.replace(/[\\/]+$/, '')}/session-lights`
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? path
}

function cut(text: string, room: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= room ? one : `${one.slice(0, Math.max(1, room - 1))}…`
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** Writes this session's light to its file, then refreshes the board. */
async function publish($: Dollar, extra: { closed?: boolean; ended?: boolean } = {}) {
  try {
    const dir = await lightsDir($)
    const id = await $.session.id()
    const s = await read($, self)
    const record = {
      id,
      title: s.title || s.project || 'session',
      project: s.project,
      light: s.light,
      why: s.why,
      since: s.since,
      beat: await $.clock.now(),
      // Why the sidebar dot isn't on this chat's title, when it isn't.
      ...(titleNote ? { titleNote } : {}),
      ...extra,
    }
    await $.fs.write(`${dir}/${id}.json`, JSON.stringify(record))
  } catch (error) {
    $.ui.log(`session-lights: could not write the light: ${String(error)}`, { to: 'debug' })
  }
  await pollBoard($, true)
}

// Writes run one after another, off the engine's path, so a turn never waits on the disk.
let writes: Promise<void> = Promise.resolve()
function queuePublish($: Dollar, extra: { closed?: boolean; ended?: boolean } = {}): Promise<void> {
  writes = writes.then(() => publish($, extra)).catch(() => undefined)
  return writes
}

/** Sets this session's light; `since` moves only when the colour changes. */
async function setLight($: Dollar, light: LightColor, why: string, patch: Partial<LightSelf> = {}) {
  const now = await $.clock.now()
  await update($, self, s => ({
    ...s,
    ...patch,
    light,
    why,
    since: s.light === light && s.since > 0 ? s.since : now,
  }))
  void queuePublish($)
  void syncTitle($)
}

// The light in the left sidebar: each session puts its own dot in front of its title.
const EMOJI: Record<LightColor, string> = { green: '🟢', yellow: '🟡', red: '🔴', grey: '⚪' }
const LIGHT_PREFIX = /^(?:(?:🟢|🟡|🔴|⚪|⚫)️?\s*)+/u

function stripLight(title: string): string {
  return title.replace(LIGHT_PREFIX, '')
}

function mcpText(result: { content: readonly unknown[] }): string {
  return result.content
    .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('')
}

// A call to the app that gives no answer in this long is taken as one that never will.
const CALL_WAIT_MS = 10_000

async function orTimeout<T>($: Dollar, work: Promise<T>): Promise<T | 'timeout'> {
  return Promise.race([work, $.clock.sleep(CALL_WAIT_MS).then(() => 'timeout' as const)])
}

async function currentTitle($: Dollar): Promise<string> {
  const got = await orTimeout($, $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' }))
  if (got === 'timeout') throw new Error('get_session gave no answer')
  if (got.isError) throw new Error(mcpText(got))
  const title = (JSON.parse(mcpText(got)) as { title?: unknown }).title
  return typeof title === 'string' ? title : ''
}

async function rename($: Dollar, title: string): Promise<{ isDone: boolean; text: string }> {
  const call = $.mcp.call('ccd_session_mgmt', 'set_session_title', { session_id: 'self', title })
  const done = await orTimeout($, call)
  if (done === 'timeout') {
    return {
      isDone: false,
      text: 'no answer: the app holds the rename of a hand-typed name for an approval it never shows',
    }
  }
  return { isDone: !done.isError, text: mcpText(done) }
}

// One rename at a time; a change that lands meanwhile is applied once the current one is done.
// The app won't let the mod rename a name the person typed by hand: it refuses, or holds the
// call for an approval card it never shows (no answer within CALL_WAIT_MS). The mod then stops
// renaming, and asks Claude once, on the person's next prompt, to rename the chat itself, which
// does show the approval card (see the `prompt.submit` hook). Any other failure (the app's
// tools not connected yet, at a session's start) is tried again on the next heartbeat.
let titleBusy = false
let titleAgain = false
let titleRefused = false
let titleNote = ''
let askedClaude = false
async function syncTitle($: Dollar) {
  if (titleRefused) return
  if (titleBusy) {
    titleAgain = true
    return
  }
  titleBusy = true
  try {
    do {
      titleAgain = false
      if ((await $.store.get('titles')) === false) return
      const current = await currentTitle($)
      if (!current) return
      const s = await read($, self)
      const wanted = `${EMOJI[s.light]} ${stripLight(current)}`
      if (wanted === current) {
        titleNote = ''
        continue
      }
      const renamed = await rename($, wanted)
      if (!renamed.isDone) {
        titleRefused = true
        titleNote = `rename refused: ${cut(renamed.text, 200)}`
        void queuePublish($)
        return
      }
      titleNote = ''
    } while (titleAgain)
  } catch (error) {
    // Not a refusal (the app's tools not connected yet, say): the next heartbeat tries again.
    titleNote = `rename failed, will retry: ${cut(String(error), 200)}`
  } finally {
    titleBusy = false
  }
}

/** The one-off note that asks Claude to rename a hand-named chat, or undefined for none. */
async function renameNote($: Dollar): Promise<string | undefined> {
  if (!titleRefused || askedClaude) return undefined
  if ((await $.store.get('titles')) === false) return undefined
  if ((await $.store.get(`declined:${await $.session.id()}`)) === true) return undefined
  const current = await currentTitle($)
  if (!current) return undefined
  askedClaude = true
  const wanted = `${EMOJI.green} ${stripLight(current)}`
  return [
    '[session-lights mod] The user typed this chat\'s name by hand, so the app refuses the',
    'mod\'s own rename and the sidebar shows no status dot for this chat. Before you start on',
    'the message, call mcp__ccd_session_mgmt__set_session_title once (load it with ToolSearch',
    `if it is deferred) with session_id "self" and title "${wanted}". The app asks the user to`,
    'approve it in a card. If they decline or it fails, carry on and do not try again.',
    'Mention it in one short line at most.',
  ].join(' ')
}

/** Takes the light off this session's title (for `/lights off`). */
async function clearTitle($: Dollar) {
  const current = await currentTitle($)
  if (current && stripLight(current) !== current) await rename($, stripLight(current))
}

/** Re-reads every session's file into the board while the pane is open. */
async function pollBoard($: Dollar, force = false) {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isOpen) return
  const dir = await lightsDir($)
  const now = await $.clock.now()
  const myId = await $.session.id()
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter(
    f => f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs < KEEP_MS,
  )
  const records = await Promise.all(
    files.map(f =>
      $.fs
        .read(`${dir}/${f.name}`)
        .then(text => JSON.parse(text) as Record<string, unknown>)
        .catch(() => undefined),
    ),
  )
  const rows: LightRow[] = []
  for (const rec of records) {
    if (!rec || rec.ended === true || typeof rec.id !== 'string') continue
    const beat = typeof rec.beat === 'number' ? rec.beat : 0
    const isStale = rec.closed === true || now - beat > STALE_MS
    let light = (rec.light as LightColor) in COLOR ? (rec.light as LightColor) : 'grey'
    let why = typeof rec.why === 'string' ? rec.why : ''
    // A gone process can't be working or waiting any more; a question it asked still stands.
    if (isStale && (light === 'green' || light === 'yellow')) {
      why = light === 'green' ? 'stopped (session closed mid-turn)' : 'closed while waiting'
      light = 'grey'
    }
    rows.push({
      id: rec.id,
      title: typeof rec.title === 'string' ? rec.title : 'session',
      project: typeof rec.project === 'string' ? rec.project : '',
      light,
      why,
      since: typeof rec.since === 'number' ? rec.since : beat,
      isStale,
      isSelf: rec.id === myId,
    })
  }
  rows.sort((a, b) => RANK[a.light] - RANK[b.light] || b.since - a.since)
  const before = await read($, board)
  const isSame = JSON.stringify(before) === JSON.stringify(rows)
  // Rewrite unchanged rows now and then so the ages on screen move on.
  if (isSame && !force && now - lastBoardWrite < 30_000) return
  lastBoardWrite = now
  await update($, board, () => rows)
}

function addWaiter(list: LightWaiter[], waiter: LightWaiter): LightWaiter[] {
  return [...list.filter(w => w.id !== waiter.id), waiter]
}

async function waitingCount($: Dollar): Promise<number> {
  const now = await $.clock.now()
  const s = await read($, self)
  const waiters = s.waiters.filter(w => now - w.at < WAITER_MAX_MS)
  const agents = await $.agent.list().catch(() => [])
  const busy = agents.filter(a => a.status === 'running' || a.status === 'pending').length
  return Math.max(waiters.length, busy)
}

// The panel listing every session opens only on `/lights`; the sidebar dots are the main view.
async function openPane($: Dollar) {
  await $.store.set('panel', true)
  await $.ui.open({ id: PANE, title: TITLE, placement: 'widget' })
  await pollBoard($, true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lights',
      description: 'Session lights: panel of every session; "off" / "on" for the sidebar dots',
      argumentHint: '[off | on]',
    })
    const project = baseName(await $.session.root())
    await update($, self, s => ({ ...s, project }))
    // The heartbeat also puts the dot back: after a failed try, or a rename by hand.
    $.clock.every(BEAT_MS, () => {
      void queuePublish($)
      void syncTitle($)
    })
    $.clock.every(POLL_MS, () => void pollBoard($))
    void queuePublish($)
    void syncTitle($)
    if ((await $.store.get('panel')) !== true) void $.ui.close({ id: PANE }).catch(() => undefined)
    return next(e)
  }).catch(passThrough)

  on('command.run', { command: 'lights' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await $.store.set('titles', false)
      await clearTitle($)
      return {
        text: 'Sidebar lights off: sessions stop adding a dot to their titles (each clears its own dot on its next change).',
      }
    }
    if (arg === 'on') {
      await $.store.set('titles', true)
      await $.store.delete(`declined:${await $.session.id()}`)
      titleRefused = false
      askedClaude = false
      titleNote = ''
      await syncTitle($)
      return {
        text: titleRefused
          ? 'Sidebar lights on. This chat has a hand-typed name: Claude asks to rename it on your next message.'
          : 'Sidebar lights on.',
      }
    }
    await openPane($)
    return { text: 'Session lights panel opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set('panel', false)
    return next(e)
  }).catch(passThrough)

  // The session's title, where the host hands one to the settings hooks (without our dot).
  on('classic.SessionStart', async ($, e, next) => {
    const title = stripLight(e.session_title ?? '')
    if (title) await update($, self, s => ({ ...s, title }))
    return next(e)
  }).catch(passThrough)
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const title = stripLight(e.session_title ?? '')
    if (title) await update($, self, s => ({ ...s, title }))
    return next(e)
  }).catch(passThrough)

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      // No title from the host: name the session after its first prompt.
      const words = e.text.trim()
      if (words) await update($, self, s => (s.title ? s : { ...s, title: cut(words, 48) }))
      // The person is here to approve a card: ask Claude to rename a hand-named chat once.
      const note = await renameNote($).catch(() => undefined)
      if (note) return next({ ...e, context: [...(e.context ?? []), note] })
    }
    if (e.origin.kind === 'task-notification') {
      // A background task reported back: drop its wait (or the oldest, if no id matches).
      await update($, self, s => {
        const tasks = s.waiters.filter(w => w.kind === 'task')
        const hit = tasks.filter(w => e.text.includes(w.id))
        const drop = new Set((hit.length ? hit : tasks.slice(0, 1)).map(w => w.id))
        return { ...s, waiters: s.waiters.filter(w => !drop.has(w.id)) }
      })
    }
    return next(e)
  }).catch(passThrough)

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Wakeups and side sessions have done their job once a turn starts.
      const s = await read($, self)
      const waiters = s.waiters.filter(w => w.kind === 'task')
      await setLight($, 'green', 'working', { asked: '', isTurn: true, waiters })
    }
    return next(e)
  }).catch(passThrough)

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const isMain = input.agentId === undefined
    const now = await $.clock.now()

    if (tool === 'AskUserQuestion') await setLight($, 'red', 'asked you a question')
    if (isMain && tool === 'mcp__ccd_turn__wrap_up' && typeof input.ask === 'string' && input.ask) {
      await update($, self, s => ({ ...s, asked: String(input.ask) }))
    }

    const ran = await next(e)

    // Claude renamed this chat (the person approved the card): the mod may rename it from now on.
    if (isMain && tool === 'mcp__ccd_session_mgmt__set_session_title' && input.session_id === 'self') {
      if (ran.deny === undefined && !ran.isError) {
        titleRefused = false
        titleNote = ''
        void syncTitle($)
      } else if (askedClaude) {
        await $.store.set(`declined:${await $.session.id()}`, true)
        titleNote = 'you declined the rename (/lights on asks again)'
      }
      void queuePublish($)
    }

    const s = await read($, self)
    if (s.isTurn && s.light === 'red') await setLight($, 'green', 'working')

    if (ran.deny === undefined) {
      const isBackground = input.run_in_background === true
      const found = /\bID:\s*([A-Za-z0-9_-]{4,})/.exec(ran.text ?? '')?.[1]
      let waiter: LightWaiter | undefined
      if ((tool === 'Bash' || tool === 'PowerShell') && isBackground) {
        waiter = { kind: 'task', id: found ?? e.tool_use_id ?? String(now), at: now }
      } else if (tool === 'Monitor') {
        waiter = { kind: 'task', id: found ?? e.tool_use_id ?? String(now), at: now }
      } else if (tool === 'ScheduleWakeup' && input.stop !== true) {
        waiter = { kind: 'wakeup', id: 'wakeup', at: now }
      } else if (tool === 'mcp__ccd_session__start_session' && input.initiation !== 'offer' && input.initiation !== 'own_initiative') {
        waiter = { kind: 'session', id: `session-${e.tool_use_id ?? now}`, at: now }
      }
      if (waiter) {
        const w = waiter
        await update($, self, cur => ({ ...cur, waiters: addWaiter(cur.waiters, w) }))
      }
    }
    return ran
  }).catch(passThrough)

  // A permission prompt waits on the person: red until the tool call goes on.
  on('classic.PermissionRequest', async ($, e, next) => {
    await setLight($, 'red', `wants permission: ${e.tool_name}`)
    return next(e)
  }).catch(passThrough)
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') await setLight($, 'red', 'wants permission')
    return next(e)
  }).catch(passThrough)

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const s = await read($, self)
    const lines = e.answer.split('\n').map(l => l.trim()).filter(Boolean)
    const endsAsking = /\?[\s*_`)"'”’]*$/.test(lines.at(-1) ?? '')
    const waiting = await waitingCount($)
    if (e.reason === 'aborted') {
      await setLight($, 'grey', 'stopped', { isTurn: false })
    } else if (e.reason === 'error' || e.reason === 'refusal') {
      await setLight($, 'red', 'turn failed', { isTurn: false })
    } else if (s.asked || endsAsking) {
      await setLight($, 'red', s.asked ? `asks: ${cut(s.asked, 60)}` : 'asked you a question', {
        isTurn: false,
      })
    } else if (waiting > 0) {
      const what = waiting === 1 ? '1 background task' : `${waiting} background tasks`
      await setLight($, 'yellow', `waiting on ${what}`, { isTurn: false })
    } else {
      await setLight($, 'grey', 'done', { isTurn: false })
    }
    return result
  }).catch(passThrough)

  on('session.end', async ($, e, next) => {
    await queuePublish($, e.reason === 'clear' ? { ended: true } : { closed: true })
    return next(e)
  }).catch(passThrough)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, board)
    const now = await $.clock.now()
    const isWidget = e.props.placement === 'widget'
    const width = Math.max(16, e.props.bodyColumns ?? 40)

    if (rows.length === 0) {
      return <Text dimColor>No session has reported a light yet.</Text>
    }
    // The light itself: a large dot, so it reads at a glance from across the window.
    const dot = (light: LightColor, size: 'heading' | 'title') => (
      <Text color={COLOR[light]} size={size} weight="bold">
        ●{' '}
      </Text>
    )
    if (isWidget) {
      return (
        <Box flexDirection="column">
          {rows.slice(0, 12).map(r => (
            <Box key={r.id} flexDirection="row" alignItems="center">
              {dot(r.light, 'heading')}
              <Text weight={r.isSelf ? 'bold' : 'semibold'} dimColor={r.light === 'grey'}>
                {cut(r.title, width - 3)}
              </Text>
            </Box>
          ))}
          {rows.length > 12 && <Text dimColor>+{rows.length - 12} more</Text>}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {rows.map(r => (
          <Box key={r.id} flexDirection="row" alignItems="center" marginBottom={1}>
            {dot(r.light, 'title')}
            <Box flexDirection="column">
              <Text weight={r.isSelf ? 'bold' : 'semibold'}>{cut(r.title, width - 4)}</Text>
              <Box flexDirection="row">
                <Text
                  size="footnote"
                  color={r.light === 'grey' ? undefined : COLOR[r.light]}
                  dimColor={r.light === 'grey'}
                >
                  {cut(r.why, Math.max(8, width - 24))}
                </Text>
                <Text size="footnote" dimColor>
                  {cut([' ', r.project, age(now - r.since)].filter(Boolean).join(' · '), 22)}
                </Text>
              </Box>
            </Box>
          </Box>
        ))}
        <Box flexDirection="row" marginTop={1}>
          {(['green', 'yellow', 'red', 'grey'] as const).map(light => (
            <Box key={`legend-${light}`} flexDirection="row">
              <Text size="caption" color={COLOR[light]}>
                ●{' '}
              </Text>
              <Text size="caption" dimColor>
                {LABEL[light]}
                {'   '}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
