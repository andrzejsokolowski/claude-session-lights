# Session lights

A Claude Code mod that puts a status light in front of each chat's name in the Claude desktop app's sidebar, so you can see which chats need you without opening them:

| Light | Meaning |
| --- | --- |
| 🟢 | Claude is working |
| 🟡 | The turn ended, but Claude is waiting on background work (a background command, a subagent, a scheduled wakeup) and will continue by itself |
| 🔴 | Claude needs you: it asked a question, wants a permission, or the turn failed |
| ⚪ | Done, waiting for you to look |

The light changes as the chat's state changes. Your own name for the chat is kept; only the dot in front of it changes.

## Install

In a terminal session of Claude Code, type:

```
/plugin install session-lights --marketplace andrzejsokolowski/claude-session-lights
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install session-lights --marketplace andrzejsokolowski/claude-session-lights
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `andrzejsokolowski/claude-session-lights`, then **Add plugin**.

Each chat gets its light once its session starts with the mod installed (open the chat and send a message, or restart the app).

## Commands

- `/lights` opens a panel beside the chat that lists every session and its light.
- `/lights off` removes this chat's dot and stops all sessions adding dots. `/lights on` turns them back on.

## Chats you named yourself

The desktop app protects names you typed by hand: it won't let the mod rename such a chat on its own. In those chats, the first time you send a message, Claude asks to rename the chat once (`🟢 your name`) and the app shows you an approval card. Approve it, and from then on the mod changes the dot by itself. If you decline, the mod remembers and doesn't ask again in that chat; `/lights on` there asks again.

## Good to know

- It works in the Claude desktop app (Code tab), whose sidebar shows the chat names. Elsewhere it does nothing visible.
- It uses none of your Claude usage: everything runs locally. The only exception is the one rename Claude makes in a chat you named yourself.
- Each session writes a small status file to `~/.claude/session-lights/` (or `$CLAUDE_CONFIG_DIR/session-lights/`), which the `/lights` panel reads.
