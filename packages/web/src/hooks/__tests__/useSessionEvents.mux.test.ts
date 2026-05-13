import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import type { DashboardSession } from "@/lib/types";

const now = new Date().toISOString();
const s1 = { id: "s1", projectId: "proj", lastActivityAt: now } as unknown as DashboardSession;

describe("useSessionEvents - mux", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [s1] }),
      } as unknown as Response),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("triggers refresh when mux patch contains unknown id", async () => {
    const initialSessions = [s1];
    const muxSessions = [
      {
        id: "s1",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
      {
        id: "s2",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];
    renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions?project=proj",
        expect.objectContaining({ cache: "no-store" }),
      );
    });
  });

  it("does not warn when an in-flight refresh is aborted on unmount", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          }),
      ),
    );

    const initialSessions = [s1];
    const muxSessions = [
      {
        id: "s1",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
      {
        id: "s2",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];

    const { unmount } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await vi.advanceTimersByTimeAsync(120);
    unmount();
    await Promise.resolve();

    expect(warnSpy).not.toHaveBeenCalledWith(
      "[useSessionEvents] refresh failed:",
      expect.anything(),
    );
  });

  it("marks mux errors as refresh failures when cached sessions exist", async () => {
    const initialSessions = [s1];
    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        muxLastError: "mux exploded",
        attentionZones: "simple",
      }),
    );

    await waitFor(() => {
      expect(result.current.refreshFailed).toBe(true);
    });
    expect(result.current.firstLoadFailed).toBe(false);
    expect(result.current.loadError).toBeNull();
  });

  it("marks mux errors as first-load failures when no sessions have resolved", async () => {
    const initialSessions: DashboardSession[] = [];
    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        muxLastError: "mux exploded",
        attentionZones: "simple",
      }),
    );

    await waitFor(() => {
      expect(result.current.firstLoadFailed).toBe(true);
    });
    expect(result.current.refreshFailed).toBe(false);
    expect(result.current.loadError).toBe("mux exploded");
  });

  it("clears refresh failures on the next successful mux snapshot", async () => {
    const initialSessions = [s1];
    const { result, rerender } = renderHook(
      (props: {
        muxLastError?: string | null;
        muxSessions?: Parameters<typeof useSessionEvents>[0]["muxSessions"];
      }) =>
        useSessionEvents({
          initialSessions,
          muxLastError: props.muxLastError,
          muxSessions: props.muxSessions,
          attentionZones: "simple",
        }),
      { initialProps: { muxLastError: "mux exploded", muxSessions: undefined } },
    );

    await waitFor(() => {
      expect(result.current.refreshFailed).toBe(true);
    });

    rerender({
      muxLastError: "mux exploded",
      muxSessions: [
        {
          id: "s1",
          status: "working",
          activity: "active",
          attentionLevel: "working",
          lastActivityAt: now,
        },
      ],
    });

    await waitFor(() => {
      expect(result.current.refreshFailed).toBe(false);
    });
    expect(result.current.firstLoadFailed).toBe(false);
    expect(result.current.loadError).toBeNull();
  });

  it("marks HTTP refresh errors as refresh failures", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "refresh exploded" }),
      } as unknown as Response),
    );

    const initialSessions = [s1];
    const muxSessions = [
      {
        id: "s1",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
      {
        id: "s2",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];
    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
      await Promise.resolve();
    });

    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.firstLoadFailed).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith("[useSessionEvents] refresh failed:", expect.any(Error));
  });
});
