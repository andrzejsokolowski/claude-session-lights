import { expect, test } from 'claude-code/testing'

const ROWS = [
  { id: 'a', title: 'Fix the login bug', project: 'web-app', light: 'red', why: 'asks: Commit it?', since: 0, isStale: false, isSelf: false },
  { id: 'b', title: 'Refactor the parser', project: 'web-app', light: 'yellow', why: 'waiting on 1 background task', since: 0, isStale: false, isSelf: false },
  { id: 'c', title: 'Image gallery layout', project: 'web-app', light: 'green', why: 'working', since: 0, isStale: false, isSelf: true },
  { id: 'd', title: 'Release notes', project: 'docs', light: 'grey', why: 'done', since: 0, isStale: false, isSelf: false },
]

for (const placement of ['dock', 'widget'] as const) {
  test(`the board draws every light (${placement}), on every surface`, async ($, on) => {
    on('state.get', (_, e) =>
      e.key === 'board'
        ? { value: { value: { shape: 'board-1', value: ROWS }, version: 1 } }
        : { value: { value: undefined, version: 0 } },
    )
    on('clock.now', () => ({ value: 120_000 }))

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'session-lights',
        component: 'Pane',
        requestId: 'session-lights',
        surface,
        props: {
          title: 'Session lights',
          isFocused: false,
          bodyColumns: 48,
          placement,
          scroll: { offset: 0, bodyRows: 30 },
          view: {},
        },
      })
      for (const title of ['Fix the login bug', 'Refactor the parser', 'Image gallery layout', 'Release notes']) {
        expect((await ui.find({ type: 'Text', text: new RegExp(title) }))?.text).toContain(title)
      }
      if (placement === 'dock') {
        expect((await ui.find({ type: 'Text', text: /asks: Commit it\?/ }))?.text).toContain('asks')
        expect((await ui.find({ type: 'Text', text: /needs you/ }))?.text).toContain('needs you')
      }
      await ui.unmount()
    }
  })
}
