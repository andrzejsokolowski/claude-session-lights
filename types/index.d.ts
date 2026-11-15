export type LightColor = 'green' | 'yellow' | 'red' | 'grey'

/** Something the session waits on that will wake it again by itself. */
export type LightWaiter = { kind: 'task' | 'wakeup' | 'session'; id: string; at: number }

/** This session's own light and what decides it. */
export type LightSelf = {
  title: string
  project: string
  light: LightColor
  why: string
  since: number
  /** The question the turn ended on (wrap_up's ask), '' for none. */
  asked: string
  /** True while a turn runs: a red set mid-turn turns green again once answered. */
  isTurn: boolean
  waiters: LightWaiter[]
}

/** One row of the board: a session's light as read from its file. */
export type LightRow = {
  id: string
  title: string
  project: string
  light: LightColor
  why: string
  since: number
  isStale: boolean
  isSelf: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-lights': {
      self: Shaped<LightSelf>
      board: Shaped<LightRow[]>
    }
  }
}
