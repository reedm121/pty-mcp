#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as pty from "node-pty";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CWD = process.cwd();

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // kill idle sessions after 5 min
const DEFAULT_SPAWN_IDLE_MS = 3000; // wait for output to settle after spawn
const DEFAULT_WRITE_IDLE_MS = 2000; // wait for output to settle after write
const MAX_IDLE_TIMEOUT_MS = 30_000; // max allowed idle timeout per request
const MAX_SESSIONS = 20; // max concurrent PTY sessions
const MAX_BUFFER_SIZE = 512 * 1024; // 512 KB max per session buffer

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  process: pty.IPty;
  buffer: string;
  isRunning: boolean;
  exitCode: number | undefined;
  lastActivity: number;
}

const sessions = new Map<string, Session>();

/** Drain the buffer and return its contents, then clear it. */
function drainBuffer(session: Session): string {
  const output = session.buffer;
  session.buffer = "";
  return output;
}

/**
 * Wait until the session's output has been idle for `idleMs` milliseconds,
 * or the process has exited, whichever comes first.
 */
function waitForIdle(session: Session, idleMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!session.isRunning) {
      setTimeout(resolve, 200);
      return;
    }

    let lastLen = session.buffer.length;
    let stableFor = 0;

    const poll = setInterval(() => {
      if (!session.isRunning) {
        clearInterval(poll);
        setTimeout(resolve, 200);
        return;
      }

      const currentLen = session.buffer.length;
      if (currentLen === lastLen) {
        stableFor += 100;
        if (stableFor >= idleMs) {
          clearInterval(poll);
          resolve();
        }
      } else {
        lastLen = currentLen;
        stableFor = 0;
      }
    }, 100);
  });
}

/** Kill a session and clean up. */
function killSession(session: Session): void {
  if (session.isRunning) {
    try {
      session.process.kill();
    } catch {
      // already dead
    }
  }
  sessions.delete(session.id);
}

/** Periodic cleanup of idle sessions. */
setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      killSession(session);
    }
  }
}, 30_000);

// Graceful shutdown
const shutdown = () => {
  for (const session of sessions.values()) {
    killSession(session);
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdown();
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  shutdown();
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "pty-mcp",
  version: "1.0.0",
});

// ---- Tool: pty_spawn -------------------------------------------------------

server.tool(
  "pty_spawn",
  "Spawn a command in a pseudo-terminal. Returns session ID and initial output. Use pty_write to send input to interactive prompts.",
  {
    command: z.string().describe("The command to run (e.g., 'npx', 'node', 'drizzle-kit')"),
    args: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Arguments for the command"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory. Defaults to the directory where the server was started."),
    env_vars: z
      .record(z.string())
      .optional()
      .describe("Additional env vars to set (merged with process.env)"),
    idle_timeout_ms: z
      .number()
      .max(MAX_IDLE_TIMEOUT_MS)
      .optional()
      .default(DEFAULT_SPAWN_IDLE_MS)
      .describe("Wait until output is idle for this many ms before returning (default 3000, max 30000)"),
  },
  async ({ command, args, cwd, env_vars, idle_timeout_ms }) => {
    if (sessions.size >= MAX_SESSIONS) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Session limit reached (${MAX_SESSIONS}). Kill an existing session first with pty_kill.`,
          },
        ],
        isError: true,
      };
    }

    const sessionId = randomUUID();
    const workDir = cwd || DEFAULT_CWD;
    const env = { ...process.env, ...(env_vars || {}) } as Record<string, string>;

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(command, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: workDir,
        env,
      });
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to spawn "${command}": ${err.message || err}`,
          },
        ],
        isError: true,
      };
    }

    const session: Session = {
      id: sessionId,
      process: ptyProcess,
      buffer: "",
      isRunning: true,
      exitCode: undefined,
      lastActivity: Date.now(),
    };

    sessions.set(sessionId, session);

    // Collect output
    ptyProcess.onData((data: string) => {
      const clean = stripAnsi(data);
      session.buffer += clean;
      session.lastActivity = Date.now();

      // Prevent unbounded buffer growth
      if (session.buffer.length > MAX_BUFFER_SIZE) {
        session.buffer = session.buffer.slice(-MAX_BUFFER_SIZE);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.isRunning = false;
      session.exitCode = exitCode;
    });

    // Wait for initial output to settle
    await waitForIdle(session, idle_timeout_ms);

    const output = drainBuffer(session);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            session_id: sessionId,
            output,
            is_running: session.isRunning,
            exit_code: session.exitCode,
          }),
        },
      ],
    };
  }
);

// ---- Tool: pty_write -------------------------------------------------------

server.tool(
  "pty_write",
  "Send input to a running PTY session. Returns new output after the input is processed. Use press_enter to submit (default true).",
  {
    session_id: z.string().describe("Session ID from pty_spawn"),
    input: z.string().describe("Text to send to the process"),
    press_enter: z
      .boolean()
      .optional()
      .default(true)
      .describe("Append Enter/Return after input (default true)"),
    idle_timeout_ms: z
      .number()
      .max(MAX_IDLE_TIMEOUT_MS)
      .optional()
      .default(DEFAULT_WRITE_IDLE_MS)
      .describe("Wait until output is idle for this many ms before returning (default 2000, max 30000)"),
  },
  async ({ session_id, input, press_enter, idle_timeout_ms }) => {
    const session = sessions.get(session_id);
    if (!session) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Session "${session_id}" not found. It may have expired or been killed.`,
          },
        ],
        isError: true,
      };
    }

    if (!session.isRunning) {
      const remaining = drainBuffer(session);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              output: remaining,
              is_running: false,
              exit_code: session.exitCode,
              note: "Process already exited before write.",
            }),
          },
        ],
      };
    }

    // Clear buffer before writing so we only capture new output
    session.buffer = "";
    session.lastActivity = Date.now();

    // Send input
    const toSend = press_enter ? input + "\r" : input;
    session.process.write(toSend);

    // Wait for response output to settle
    await waitForIdle(session, idle_timeout_ms);

    const output = drainBuffer(session);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            output,
            is_running: session.isRunning,
            exit_code: session.exitCode,
          }),
        },
      ],
    };
  }
);

// ---- Tool: pty_kill --------------------------------------------------------

server.tool(
  "pty_kill",
  "Kill a running PTY session.",
  {
    session_id: z.string().describe("Session ID to kill"),
  },
  async ({ session_id }) => {
    const session = sessions.get(session_id);
    if (!session) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Session "${session_id}" not found.`,
          },
        ],
        isError: true,
      };
    }

    killSession(session);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: true }),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
