# session-panel

A Claude Code mod that adds a panel beside the conversation, so you can see what a session is
doing and costing you without running `/context` or `/usage`.

From the top, the panel shows:

- **Repository**: name, branch, and up to 8 uncommitted files with their git status letter.
  Click `+N more` to list them all. Click a file to open Claude Code's diff panel (`/diff`),
  then pick the file in its list: the diff panel cannot be opened at one file. It opens as a
  tab in the same place as this panel; widen that area to read a diff comfortably.
- **Model**: the model and effort level the last request used.
- **Context**: how full the context window is. The bar is split into colours by what fills it
  (messages, tools, MCP tools, system prompt, memory files and so on), and the list under it is
  its key. Under the list, the cache bar drains as the prompt cache ages: yellow at half its
  life, orange at a quarter, red near the end. Once the cache lapses, the next message sends the
  whole context again at full price. A notice pops up when the context passes 90%.
- **Usage**: your 5-hour and weekly allowances, and any per-model weekly limit. A bar turns
  yellow at 50% used and orange at 80%; a per-model limit turns red at 90%.
- **Weather**: now, and a 5-day forecast for where you are.
- **Agents**: a card for each subagent: what it is doing now, how long it has been at it, its
  own context use, its tool calls and how much it has written. Each card has Claude Code's
  mascot wearing its own hat, so two agents on screen never look alike; it is orange while the
  agent works, grey once it finishes or is stopped, and red if it failed. Up to five cards show
  at once, running agents first, and a finished agent stays for 3 minutes. An agent started by
  another agent has its card set in under that agent's, joined to it by a line.

  Click an agent's name to see its conversation in place of the main one; its card is
  marked `▶` while you do. A line just above the agents then leads back: `← main` returns to
  the main conversation, and the name of each agent above it (the one that started it, and so
  on) opens that agent's. Clicking the marked card again goes back up one level. Claude Code
  lets go of a finished agent after a while, and from then on its conversation cannot be
  opened; the panel says so when that happens.

## Install

Type this at the prompt of a Claude Code session in your terminal:

```
/plugin install session-panel --marketplace jasonshave/session-panel
```

Answer `y` to add the marketplace, then pick where to install it (for you, or for one project).

The panel docks beside the conversation in Claude Code's fullscreen layout. Turn that on with
`"tui": "fullscreen"` in `~/.claude/settings.json`. Without it, or in a terminal narrower than
110 characters, the panel sits above the prompt instead.

Type `/dash` to show or hide the panel. It opens by itself when a session starts if the
terminal is at least 144 characters wide, or 110 if you have opened it with `/dash` before and
not closed it since. On a narrower terminal it appears once you widen the window. Drag its edge
to resize it; Claude Code remembers the width.

## What it reads, keeps and sends

Three requests leave your machine:

| Request | Why | What is sent |
| --- | --- | --- |
| `wttr.in` | Finds your town for the forecast, at most once a day | Your IP address |
| `api.open-meteo.com` | The forecast, every 30 minutes | Your town's coordinates (and, like any request, your IP address) |
| `api.anthropic.com/api/oauth/usage` | The per-model weekly limit, every 5 minutes | Your Claude sign-in token, read from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) |

On your machine it runs `git status` in the session's folder when the session starts, after
each turn and once a minute. Once per session (or when you resume one) it runs `node` on its
own `scripts/cache-expiry.js`, which reads the last 512 KB of the session's transcript to learn
when the prompt cache was last used and whether it lasts 5 minutes or an hour. It reads your
Claude Code settings for the effort level.

It keeps your town and its coordinates, the last forecast, the per-model limits and the cache
lifetime in its own storage, so a new session can draw them at once.

## Limits

- **Progress and time left** only appear for an agent that keeps a to-do list (TodoWrite, or
  the task tools), and the time left only once it has finished its first item. Claude Code does
  not otherwise say how far through its work an agent is, and many agents have no to-do tool,
  so expect this line rarely.
- **The per-model weekly limit** comes from an Anthropic web address that is not a published
  API, so that bar could stop working without warning. On macOS, Claude Code keeps the sign-in
  in the Keychain, so the bar does not show there.
- **No Node.js**: the cache bar does not show.
- **An agent's context window** is known for the session's own model. Any other model is
  shown against 200k, or 1M if its name ends in `[1m]`.
- **Windows Terminal** draws a few weather symbols one character narrower than others, which
  can shift that day's row by one character.

## Developing

```
claude plugin validate .
claude plugin test .
```
