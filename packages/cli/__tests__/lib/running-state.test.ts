import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as fsModule from "node:fs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const testHome = join(process.cwd(), ".tmp-running-state-home");

const { mockFsyncSync } = vi.hoisted(() => ({
  mockFsyncSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => testHome,
}));

// Wrap node:fs so we can observe fsyncSync calls without breaking ESM
// namespace immutability (vi.spyOn on a node:fs export errors out).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return {
    ...actual,
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      mockFsyncSync(...args);
      return actual.fsyncSync(...args);
    },
  };
});

describe("running-state", () => {
  beforeEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("keeps running.json when the pid probe returns EPERM", async () => {
    const runningState = await import("../../src/lib/running-state.js");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as Error & { code?: string };
      error.code = "EPERM";
      throw error;
    });

    await runningState.register({
      pid: 424242,
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 4321,
      startedAt: new Date("2026-04-19T00:00:00.000Z").toISOString(),
      projects: ["my-app"],
    });

    const state = await runningState.getRunning();
    const stateFile = join(testHome, ".agent-orchestrator", "running.json");

    expect(state).toEqual({
      pid: 424242,
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 4321,
      startedAt: new Date("2026-04-19T00:00:00.000Z").toISOString(),
      projects: ["my-app"],
    });
    expect(existsSync(stateFile)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(424242, 0);
  });

  it("writeLastStop fsyncs the temp file before renaming so the record survives SIGKILL (issue #1743)", async () => {
    mockFsyncSync.mockClear();
    const runningState = await import("../../src/lib/running-state.js");

    await runningState.writeLastStop({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1", "app-2"],
    });

    const lastStopFile = join(testHome, ".agent-orchestrator", "last-stop.json");
    expect(existsSync(lastStopFile)).toBe(true);
    expect(JSON.parse(readFileSync(lastStopFile, "utf-8"))).toEqual({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1", "app-2"],
    });
    expect(mockFsyncSync).toHaveBeenCalled();
  });

  it("readLastStop round-trips otherProjects through writeLastStop", async () => {
    const runningState = await import("../../src/lib/running-state.js");

    await runningState.writeLastStop({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1"],
      otherProjects: [{ projectId: "other-app", sessionIds: ["other-1", "other-2"] }],
    });

    const read = await runningState.readLastStop();
    expect(read).toEqual({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1"],
      otherProjects: [{ projectId: "other-app", sessionIds: ["other-1", "other-2"] }],
    });
  });

  it("keeps startup locks alive when the pid probe returns EPERM", async () => {
    const runningState = await import("../../src/lib/running-state.js");
    const lockDir = join(testHome, ".agent-orchestrator");
    const lockFile = join(lockDir, "startup.lock");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as Error & { code?: string };
      error.code = "EPERM";
      throw error;
    });

    const release = await runningState.acquireStartupLock(100);

    await expect(runningState.acquireStartupLock(100)).rejects.toThrow(
      `Could not acquire startup lock (${lockFile})`,
    );
    expect(readFileSync(lockFile, "utf-8")).toContain(`"pid":${process.pid}`);

    release();
    expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
  });
});
