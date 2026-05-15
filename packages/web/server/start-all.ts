/**
 * Production entry point — starts Next.js + terminal servers.
 * Used by `ao start` when running from an npm install (no monorepo).
 * Replaces the dev-only `concurrently` setup.
 */

import { type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  isWindows,
  killProcessTree,
  markDaemonShutdownHandlerInstalled,
  spawnManagedDaemonChild,
} from "@aoagents/ao-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the package root (one level up from dist-server/)
const pkgRoot = resolve(__dirname, "..");

export const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
const POST_SIGKILL_VERIFY_MS = 2_000;

interface ManagedChild {
  label: string;
  child: ChildProcess;
  exited: boolean;
}

const children: ManagedChild[] = [];
let shuttingDown = false;

function log(label: string, msg: string): void {
  process.stdout.write(`[${label}] ${msg}\n`);
}

function logLevel(label: string, level: "info" | "warn" | "error", msg: string): void {
  log(label, `${level}: ${msg}`);
}

export function getShutdownGraceMs(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env["AO_SHUTDOWN_GRACE_MS"];
  if (!raw) return DEFAULT_SHUTDOWN_GRACE_MS;

  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHUTDOWN_GRACE_MS;
  return parsed;
}

export function formatCleanShutdownMessage(elapsedMs: number): string {
  return `all children shut down cleanly in ${elapsedMs}ms`;
}

export function formatForceKillFallbackMessage(label: string, graceMs: number): string {
  return `${label} did not exit within ${graceMs}ms — sent SIGKILL (safety fallback, no orphans leaked)`;
}

function spawnProcess(
  label: string,
  command: string,
  args: string[],
  opts?: { restart?: boolean; maxRestarts?: number },
): ChildProcess {
  let restarts = 0;
  const maxRestarts = opts?.maxRestarts ?? 3;
  let slotIndex = -1;

  function launch(): ChildProcess {
    const child = spawnManagedDaemonChild(`dashboard:${label}`, command, args, {
      cwd: pkgRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: !isWindows(),
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.on("exit", (code: number | null) => {
      const current = children[slotIndex];
      if (current?.child === child) current.exited = true;
      log(label, `exited with code ${code}`);
      if (!shuttingDown && opts?.restart && code !== 0 && restarts < maxRestarts) {
        restarts++;
        log(label, `restarting (attempt ${restarts}/${maxRestarts})`);
        const replacement = launch();
        // Replace in-place — slot was assigned on first push
        children[slotIndex] = { label, child: replacement, exited: false };
      }
    });

    // Only push on first launch; restarts replace the existing slot
    if (slotIndex === -1) {
      slotIndex = children.length;
      children.push({ label, child, exited: false });
    }

    return child;
  }

  return launch();
}

/**
 * Resolve the `next` CLI binary path.
 * Tries the local .bin shim first (fast), then falls back to require.resolve (hoisted deps).
 */
function resolveNextBin(): string {
  // On Windows, .bin/next is a POSIX shell shim that spawn() cannot execute.
  // Skip it and go straight to the JS entry point.
  if (!isWindows()) {
    const localBin = resolve(pkgRoot, "node_modules", ".bin", "next");
    if (existsSync(localBin)) return localBin;
  }

  // Resolve the actual Next.js CLI JS entry point
  const require = createRequire(resolve(pkgRoot, "package.json"));
  try {
    const nextPkg = require.resolve("next/package.json");
    return resolve(dirname(nextPkg), "dist", "bin", "next");
  } catch {
    // Last resort — rely on PATH
    return "next";
  }
}

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  const graceMs = getShutdownGraceMs();
  const shutdownStartedAt = Date.now();
  const alive = new Set(children.filter(({ exited }) => !exited));
  let forceFallbackStarted = false;

  const finishIfDone = (): void => {
    if (alive.size > 0) return;
    if (!forceFallbackStarted) {
      logLevel("start-all", "info", formatCleanShutdownMessage(Date.now() - shutdownStartedAt));
    }
    process.exit(0);
  };

  if (alive.size === 0) {
    finishIfDone();
    return;
  }

  const forceTimer = setTimeout(() => {
    forceFallbackStarted = true;
    void forceKillRemainingChildren(alive, graceMs);
  }, graceMs);
  forceTimer.unref();

  async function forceKillRemainingChildren(stuckChildren: Set<ManagedChild>, grace: number) {
    const stuck = [...stuckChildren].filter(({ exited }) => !exited);
    if (stuck.length === 0) {
      finishIfDone();
      return;
    }

    const results = await Promise.all(
      stuck.map(async ({ label, child }) => {
        logLevel("start-all", "warn", formatForceKillFallbackMessage(label, grace));
        const pid = child.pid;
        if (!pid) {
          try {
            return child.kill("SIGKILL");
          } catch {
            return false;
          }
        }

        try {
          await killProcessTree(pid, "SIGKILL");
          return true;
        } catch {
          try {
            return child.kill("SIGKILL");
          } catch {
            return false;
          }
        }
      }),
    );

    if (results.some((sent) => !sent)) {
      logLevel(
        "start-all",
        "error",
        "SIGKILL fallback failed for one or more children; manual cleanup may be required",
      );
      process.exit(1);
      return;
    }

    const verifyTimer = setTimeout(() => {
      const stillAlive = [...stuckChildren].filter(({ exited }) => !exited);
      if (stillAlive.length === 0) {
        process.exit(0);
        return;
      }

      logLevel(
        "start-all",
        "error",
        `${stillAlive.map(({ label }) => label).join(", ")} remained alive after SIGKILL; manual cleanup may be required`,
      );
      process.exit(1);
    }, POST_SIGKILL_VERIFY_MS);
    verifyTimer.unref();
  }

  for (const info of alive) {
    const { child } = info;
    child.on("exit", () => {
      info.exited = true;
      alive.delete(info);
      if (alive.size <= 0) clearTimeout(forceTimer);
      finishIfDone();
    });
    const pid = child.pid;
    if (pid) {
      void killProcessTree(pid, "SIGTERM").catch(() => {
        child.kill("SIGTERM");
      });
    } else {
      child.kill("SIGTERM");
    }
  }
}

export function runStartAll(): void {
  markDaemonShutdownHandlerInstalled();

  // Start Next.js production server
  const port = process.env["PORT"] || "3000";
  const nextBin = resolveNextBin();

  if (isWindows() && nextBin !== "next") {
    // On Windows, run the JS entry point via the current node binary.
    // spawn() can't execute .js files directly on Windows.
    spawnProcess("next", process.execPath, [nextBin, "start", "-p", port]);
  } else {
    spawnProcess("next", nextBin, ["start", "-p", port]);
  }

  // Start direct terminal WebSocket server (auto-restart on crash)
  spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")], {
    restart: true,
  });

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

const isMainModule = process.argv[1] ? resolve(process.argv[1]) === __filename : false;
if (isMainModule) runStartAll();
