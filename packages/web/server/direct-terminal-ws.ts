/**
 * Direct WebSocket terminal server.
 * Hosts the multiplexed /mux WebSocket endpoint for all terminal connections.
 */

import { createServer, type Server } from "node:http";
import { isWindows } from "@aoagents/ao-core";
import { findTmux } from "./tmux-utils.js";
import {
  createMuxWebSocket,
  PTY_SHUTDOWN_DRAIN_MS,
  type MuxWebSocketServer,
} from "./mux-websocket.js";

export interface DirectTerminalServer {
  server: Server;
  shutdown: (opts?: { drainMs?: number }) => void;
}

export function createDirectTerminalShutdownHandler(
  shutdown: () => void | Promise<void>,
  opts: {
    log?: (message: string) => void;
    warn?: (message: string) => void;
    exit?: (code: number) => never | void;
    forceTimeoutMs?: number;
  } = {},
): (signal: string) => void {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  const exit = opts.exit ?? process.exit;
  const forceTimeoutMs = opts.forceTimeoutMs ?? 5_000;
  let shuttingDown = false;

  return (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`[DirectTerminal] Received ${signal}, shutting down...`);
    void Promise.resolve(shutdown());

    if (forceTimeoutMs > 0) {
      const forceExitTimer = setTimeout(() => {
        warn(
          `[DirectTerminal] warn: forced shutdown after ${forceTimeoutMs}ms (safety fallback, no orphans leaked)`,
        );
        exit(0);
      }, forceTimeoutMs);
      forceExitTimer.unref();
    }
  };
}

/**
 * Create the direct terminal WebSocket server.
 * Separated from listen() so tests can control lifecycle.
 */
export function createDirectTerminalServer(tmuxPath?: string | null): DirectTerminalServer {
  const TMUX = tmuxPath ?? findTmux();

  let muxWss: MuxWebSocketServer | null = null;

  const metrics = {
    totalConnections: 0,
    totalDisconnects: 0,
    totalErrors: 0,
  };

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          clients: muxWss?.clients.size ?? 0,
          metrics,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  muxWss = createMuxWebSocket(TMUX);

  if (muxWss) {
    muxWss.on("connection", (ws) => {
      metrics.totalConnections++;
      ws.on("close", () => {
        metrics.totalDisconnects++;
      });
      ws.on("error", () => {
        metrics.totalErrors++;
      });
    });
  }

  // Manual upgrade routing — ws library doesn't support multiple WebSocketServer
  // instances with different `path` options on the same HTTP server.
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "ws://localhost").pathname;

    const mux = muxWss;
    if (pathname === "/mux" && mux) {
      mux.handleUpgrade(request, socket, head, (ws) => {
        mux.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  function shutdown(opts: { drainMs?: number } = {}) {
    const drainMs = opts.drainMs ?? 0;
    void (async () => {
      await muxWss?.shutdownGracefully?.(drainMs);
      if (muxWss) {
        // Send a normal close frame first so browsers receive any final PTY
        // exit messages. After the PTY drain window, terminate stragglers.
        for (const client of muxWss.clients) {
          client.close(1001, "server shutting down");
        }
        const terminateTimer = setTimeout(() => {
          if (!muxWss) return;
          for (const client of muxWss.clients) {
            client.terminate();
          }
        }, 200);
        terminateTimer.unref();
        muxWss.close();
      }
      server.close();
    })();
  }

  return { server, shutdown };
}

// --- Run as standalone script ---
// Only start the server when executed directly (not imported by tests)
const isMainModule =
  process.argv[1]?.endsWith("direct-terminal-ws.ts") ||
  process.argv[1]?.endsWith("direct-terminal-ws.js");

if (isMainModule) {
  const PORT = parseInt(process.env.DIRECT_TERMINAL_PORT ?? "14801", 10);

  // On Windows, findTmux() returns null — mux-websocket.ts handles this by
  // using named pipe relay to PTY hosts instead of tmux attach.
  const TMUX = findTmux();
  if (TMUX) {
    console.log(`[DirectTerminal] Using tmux: ${TMUX}`);
  } else if (isWindows()) {
    console.log(`[DirectTerminal] Windows mode — using named pipe relay to PTY hosts`);
  } else {
    console.log(`[DirectTerminal] No tmux available — terminal relay may be limited`);
  }

  const { server, shutdown } = createDirectTerminalServer(TMUX);

  server.listen(PORT, () => {
    console.log(`[DirectTerminal] WebSocket server listening on port ${PORT}`);
  });

  const handleShutdown = createDirectTerminalShutdownHandler(
    () => shutdown({ drainMs: PTY_SHUTDOWN_DRAIN_MS }),
    { forceTimeoutMs: 15_000 },
  );

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}
