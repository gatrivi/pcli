# pcli

Plain-text front end for Claude Code (`claude -p`) with a phone web UI. No TUI, so no redraw glitches or stuck mouse-tracking modes in Windows Terminal. Zero dependencies.

## Run

```
node server.js            # REPL in this terminal + HTTP on :7777
node server.js --headless # HTTP only
```

It prints a link with a token (`http://<ip>:7777/#<token>`). Open it on your phone. Use Tailscale to reach it from outside your network.

## Commands (PC or phone)

| Input | Does |
|---|---|
| any text | send to Claude, continues the conversation |
| `!command` | run PowerShell in the session folder |
| `/new` | fresh conversation |
| `/s <name>` | switch / create named session |
| `/ls` | list sessions |
| `/cd <path>` | change folder (fresh conversation) |
| `/mode <m>` | `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `/stop` | kill the running job |
| `/reset` | turn off stuck terminal mouse modes |

PC and phone share one live feed.

## Security

The token gives full shell access to the machine. It lives in `state.json` (git-ignored); delete that file to rotate it. Prefer Tailscale over exposing the port.
