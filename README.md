# pty-mcp

MCP server that gives AI coding agents a real pseudo-terminal (PTY) for handling interactive CLI prompts. Spawn processes, read their output, and send intelligent responses — no human in the loop.

## Why I Built This

I was using Claude Code with [Drizzle ORM](https://orm.drizzle.team) and hit a wall: `drizzle-kit generate` asks interactive questions like "Is this table created or renamed?" that Claude Code couldn't answer. It just hung. I looked for existing MCP tools to solve this but nothing trustworthy existed, so I built one.

It works for way more than just Drizzle though — any CLI tool with interactive prompts becomes fully autonomous:

- **Database migrations** — Drizzle Kit, Prisma, TypeORM, Knex
- **Project scaffolding** — `npm init`, `create-next-app`, `create-vite`, `npx degit`
- **Package managers** — `npm install` peer dep prompts, `yarn` resolutions
- **Git operations** — interactive rebase, merge conflict resolution, `git add -p`
- **Cloud CLIs** — `aws configure`, `gcloud init`, `firebase init`, `vercel`
- **Docker** — `docker build` prompts, `docker compose` confirmations
- **System tools** — `ssh-keygen`, `gpg --gen-key`, `certbot`
- **Linters/formatters** — ESLint `--init`, Prettier setup, `stylelint` config

## The Problem

AI coding agents like Claude Code can run shell commands, but they can't handle **interactive prompts**. When a CLI tool asks "Is this table created or renamed?" or "Pick a preset:", the agent gets stuck — it can't read the prompt or type an answer. This blocks any CLI workflow that requires human input — database migrations, project scaffolding, package configuration, and more.

## The Solution

`pty-mcp` gives the agent a real pseudo-terminal via the [Model Context Protocol](https://modelcontextprotocol.io). The agent can:

1. **Spawn** a command in a PTY
2. **Read** the interactive prompt output
3. **Write** an intelligent response
4. **Repeat** until the process exits

## Setup

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "pty-mcp": {
      "command": "npx",
      "args": ["-y", "pty-mcp"]
    }
  }
}
```

### Requirements

- Node.js 20+
- Build tools for native addon compilation (Python 3, make, g++)
  - macOS: `xcode-select --install`
  - Ubuntu/Debian: `sudo apt install build-essential python3`
  - Windows: Pre-built binaries included, no extra tools needed

## Tools

### `pty_spawn`

Spawn a command in a pseudo-terminal.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `command` | string | (required) | Command to run |
| `args` | string[] | `[]` | Command arguments |
| `cwd` | string | server CWD | Working directory |
| `env_vars` | object | `{}` | Extra environment variables (merged with system env) |
| `idle_timeout_ms` | number | `3000` | Wait for output to settle before returning |

**Returns:** `{ session_id, output, is_running, exit_code }`

### `pty_write`

Send input to a running PTY session.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `session_id` | string | (required) | Session ID from `pty_spawn` |
| `input` | string | (required) | Text to send |
| `press_enter` | boolean | `true` | Append Enter after input |
| `idle_timeout_ms` | number | `2000` | Wait for output to settle before returning |

**Returns:** `{ output, is_running, exit_code }`

### `pty_kill`

Kill a running session.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `session_id` | string | (required) | Session ID to kill |

**Returns:** `{ success: true }`

## Example: Handling Interactive Prompts

```
Agent calls pty_spawn({ command: "npx", args: ["drizzle-kit", "generate"] })
→ Returns output: "Is 'users' table created or renamed from another table? ❯ create / rename"

Agent reads the prompt, understands context, decides "create"
→ Calls pty_write({ session_id: "abc-123", input: "" })

Process continues, agent answers more prompts as needed...

Process exits → agent gets final output with results
```

## How It Works

- Uses [node-pty](https://github.com/microsoft/node-pty) (Microsoft, powers VS Code's terminal) for real PTY allocation
- ANSI escape codes are stripped automatically for clean output
- Sessions auto-expire after 5 minutes of inactivity
- All sessions are cleaned up on server shutdown
- No shell wrapping — commands are spawned directly (no injection risk)

## Security

- **Local only** — stdio transport, no network exposure, no ports opened
- **No shell injection** — uses `pty.spawn(command, args)` directly, not `bash -c`
- **No secrets stored** — environment variables are passed through, not logged
- **Session isolation** — each spawn gets its own PTY with a unique session ID
- **Session limits** — max 20 concurrent sessions, 30s max idle timeout per request
- **Auto-cleanup** — idle sessions killed after 5 minutes, graceful shutdown on crash

**Trust model:** This server grants command execution to the connected MCP client. Only connect it to clients you trust (e.g., Claude Code on your local machine). The server inherits your shell environment — spawned processes have access to the same env vars as your terminal.

## License

MIT
