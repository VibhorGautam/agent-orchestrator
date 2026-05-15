"use client";

import { useEffect, useReducer, useRef, useCallback } from "react";
import type { SessionPatch } from "@/lib/mux-protocol";
import {
  getAttentionLevel,
  type ActivityState,
  type AttentionLevel,
  type DashboardAttentionZoneMode,
  type DashboardSession,
  type SessionStatus,
} from "@/lib/types";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

/** Debounce before fetching full session list after membership change. */
const MEMBERSHIP_REFRESH_DELAY_MS = 120;
/** Re-fetch full session list if no refresh has happened in this interval. */
const STALE_REFRESH_INTERVAL_MS = 15000;
const LIVE_REFRESH_TIMEOUT_MS = 6000;

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("aborted") || message.includes("aborterror");
  }

  return false;
}

const VALID_ATTENTION_LEVELS = new Set<AttentionLevel>([
  "merge",
  "action",
  "respond",
  "review",
  "pending",
  "working",
  "done",
]) satisfies ReadonlySet<AttentionLevel>;
const VALID_ACTIVITY_STATES = new Set<ActivityState>([
  "active",
  "ready",
  "idle",
  "waiting_input",
  "blocked",
  "exited",
]) satisfies ReadonlySet<ActivityState>;
const VALID_SESSION_STATUSES = new Set<SessionStatus>([
  "spawning",
  "working",
  "detecting",
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
  "merged",
  "cleanup",
  "needs_input",
  "stuck",
  "errored",
  "killed",
  "idle",
  "done",
  "terminated",
]) satisfies ReadonlySet<SessionStatus>;

/** Server-computed attention levels from the latest snapshot. */
export type AttentionMap = Readonly<Record<string, AttentionLevel>>;

interface State {
  sessions: DashboardSession[];
  /** Attention levels from the latest snapshot (server-computed, includes PR state). */
  attentionLevels: AttentionMap;
  /**
   * True after a real success signal from the live path: HTTP 200 `/api/sessions`
   * refresh or a mux snapshot — not inferred from WS connect state, which fires
   * before any session data arrives.
   */
  liveSessionsResolved: boolean;
  /** First-load error message from the live session transport. Null once live data resolves. */
  loadError: string | null;
  /** True when no session data has ever resolved and the live transport reports an error. */
  firstLoadFailed: boolean;
  /** First-load error message alias used by sidebar consumers. */
  firstLoadError: string | null;
  /** True when a refresh fails after cached/resolved session data is available. */
  refreshFailed: boolean;
  /** Refresh error message shown with stale cached data. */
  refreshError: string | null;
}

type Action =
  | {
      type: "reset";
      sessions: DashboardSession[];
      attentionLevels?: AttentionMap;
      liveResolved?: boolean;
    }
  | { type: "snapshot"; patches: SessionPatch[] }
  | { type: "muxError"; error: string }
  | { type: "refreshError"; error: string }
  | { type: "clearErrors" };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "muxError": {
      const hasResolvedData = state.liveSessionsResolved || state.sessions.length > 0;
      if (hasResolvedData) {
        if (
          state.refreshFailed &&
          !state.firstLoadFailed &&
          state.loadError === null &&
          state.refreshError === action.error
        ) {
          return state;
        }
        return {
          ...state,
          loadError: null,
          firstLoadError: null,
          firstLoadFailed: false,
          refreshFailed: true,
          refreshError: action.error,
        };
      }

      if (state.firstLoadFailed && !state.refreshFailed && state.loadError === action.error) {
        return state;
      }

      return {
        ...state,
        loadError: action.error,
        firstLoadFailed: true,
        firstLoadError: action.error,
        refreshFailed: false,
        refreshError: null,
      };
    }
    case "refreshError": {
      const hasResolvedData = state.liveSessionsResolved || state.sessions.length > 0;
      if (!hasResolvedData) {
        return {
          ...state,
          loadError: action.error,
          firstLoadError: action.error,
          firstLoadFailed: true,
          refreshFailed: false,
          refreshError: null,
        };
      }

      return state.refreshFailed && state.refreshError === action.error
        ? state
        : {
            ...state,
            loadError: null,
            firstLoadError: null,
            firstLoadFailed: false,
            refreshFailed: true,
            refreshError: action.error,
          };
    }
    case "clearErrors":
      if (
        !state.firstLoadFailed &&
        !state.refreshFailed &&
        state.loadError === null &&
        state.firstLoadError === null &&
        state.refreshError === null
      ) {
        return state;
      }
      return {
        ...state,
        loadError: null,
        firstLoadError: null,
        firstLoadFailed: false,
        refreshFailed: false,
        refreshError: null,
      };
    case "reset":
      return {
        ...state,
        sessions: action.sessions,
        ...(action.liveResolved
          ? {
              liveSessionsResolved: true,
              loadError: null,
              firstLoadError: null,
              firstLoadFailed: false,
              refreshFailed: false,
              refreshError: null,
            }
          : {}),
        ...(action.attentionLevels !== undefined
          ? { attentionLevels: action.attentionLevels }
          : {}),
      };
    case "snapshot": {
      const patchMap = new Map(action.patches.map((p) => [p.id, p]));
      let changed = false;
      const next = state.sessions.map((s) => {
        const patch = patchMap.get(s.id);
        if (!patch) return s;
        if (
          s.status === patch.status &&
          s.activity === patch.activity &&
          s.lastActivityAt === patch.lastActivityAt
        ) {
          return s;
        }
        changed = true;
        return {
          ...s,
          status: VALID_SESSION_STATUSES.has(patch.status as SessionStatus)
            ? (patch.status as SessionStatus)
            : s.status,
          activity:
            patch.activity !== null && VALID_ACTIVITY_STATES.has(patch.activity as ActivityState)
              ? (patch.activity as ActivityState)
              : null,
          lastActivityAt: patch.lastActivityAt,
        };
      });

      // Build attention level map from server-computed values
      const levels: Record<string, AttentionLevel> = {};
      for (const p of action.patches) {
        if (!VALID_ATTENTION_LEVELS.has(p.attentionLevel as AttentionLevel)) {
          console.warn("[useSessionEvents] Unknown attentionLevel from server:", p.attentionLevel);
          continue;
        }
        levels[p.id] = p.attentionLevel as AttentionLevel;
      }

      const sessionsChanged = changed;
      const levelsChanged =
        Object.keys(levels).length !== Object.keys(state.attentionLevels).length ||
        action.patches.some((p) => state.attentionLevels[p.id] !== p.attentionLevel);

      if (!sessionsChanged && !levelsChanged) {
        if (
          state.liveSessionsResolved &&
          !state.firstLoadFailed &&
          !state.refreshFailed &&
          state.loadError === null &&
          state.firstLoadError === null &&
          state.refreshError === null
        ) {
          return state;
        }
        return {
          ...state,
          liveSessionsResolved: true,
          loadError: null,
          firstLoadError: null,
          firstLoadFailed: false,
          refreshFailed: false,
          refreshError: null,
        };
      }

      return {
        ...state,
        sessions: sessionsChanged ? next : state.sessions,
        attentionLevels: levelsChanged ? levels : state.attentionLevels,
        liveSessionsResolved: true,
        loadError: null,
        firstLoadError: null,
        firstLoadFailed: false,
        refreshFailed: false,
        refreshError: null,
      };
    }
  }
}

function createMembershipKey(
  sessions: Array<Pick<DashboardSession, "id">> | SessionPatch[],
): string {
  return sessions
    .map((session) => session.id)
    .sort()
    .join("\0");
}

export interface UseSessionEventsOptions {
  initialSessions: DashboardSession[];
  project?: string;
  muxSessions?: Array<{
    id: string;
    status: string;
    activity: string | null;
    attentionLevel: AttentionLevel;
    lastActivityAt: string;
  }>;
  initialAttentionLevels?: AttentionMap;
  muxLastError?: string | null;
  disabled?: boolean;
  attentionZones: DashboardAttentionZoneMode;
}

export function useSessionEvents(options: UseSessionEventsOptions): State {
  const {
    initialSessions,
    project,
    muxSessions,
    initialAttentionLevels,
    muxLastError,
    disabled = false,
    attentionZones,
  } = options;
  const [state, dispatch] = useReducer(reducer, {
    sessions: initialSessions,
    attentionLevels: initialAttentionLevels ?? ({} as AttentionMap),
    liveSessionsResolved: false,
    loadError: null,
    firstLoadError: null,
    firstLoadFailed: false,
    refreshFailed: false,
    refreshError: null,
  });
  const sessionsRef = useRef(state.sessions);
  const initialAttentionLevelsRef = useRef(initialAttentionLevels);
  initialAttentionLevelsRef.current = initialAttentionLevels;
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMembershipKeyRef = useRef<string | null>(null);
  const lastRefreshAtRef = useRef(0);
  const lastFetchStartedAtRef = useRef(0);
  const activeRefreshControllerRef = useRef<AbortController | null>(null);
  const pageUnloadingRef = useRef(false);

  // Reset state when server-rendered props change (e.g. full page refresh)
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({
      type: "reset",
      sessions: initialSessions,
      attentionLevels: initialAttentionLevelsRef.current ?? ({} as AttentionMap),
    });
  }, [initialSessions]);

  useEffect(() => {
    pageUnloadingRef.current = false;

    const markPageUnloading = () => {
      pageUnloadingRef.current = true;
    };

    window.addEventListener("pagehide", markPageUnloading);
    window.addEventListener("beforeunload", markPageUnloading);

    return () => {
      window.removeEventListener("pagehide", markPageUnloading);
      window.removeEventListener("beforeunload", markPageUnloading);
    };
  }, []);

  // Define scheduleRefresh with useCallback so both effects can use it
  const scheduleRefresh = useCallback(() => {
    // Skip scheduling if a timer is already pending
    if (refreshTimerRef.current) return;
    // Skip if a fetch was already started recently (< 500ms ago)
    if (Date.now() - lastFetchStartedAtRef.current < 500) return;
    // Skip if a fetch is currently in flight (use controller as authoritative signal)
    if (activeRefreshControllerRef.current !== null) return;

    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      // Re-check in-flight state after the 120ms debounce window
      if (activeRefreshControllerRef.current !== null) return;
      const requestedMembershipKey = pendingMembershipKeyRef.current;
      const refreshController = new AbortController();
      activeRefreshControllerRef.current = refreshController;

      lastFetchStartedAtRef.current = Date.now();

      const sessionsUrl = project
        ? `/api/sessions?project=${encodeURIComponent(project)}`
        : "/api/sessions";

      void fetchJsonWithTimeout<{ sessions?: DashboardSession[] } | null>(sessionsUrl, {
        signal: refreshController.signal,
        cache: "no-store",
        timeoutMs: LIVE_REFRESH_TIMEOUT_MS,
        timeoutMessage: `Dashboard refresh timed out after ${LIVE_REFRESH_TIMEOUT_MS}ms`,
      })
        .then((updated) => {
          if (refreshController.signal.aborted || !updated?.sessions) {
            // Update timestamp even for non-OK responses to prevent retry storms
            if (!refreshController.signal.aborted) {
              lastRefreshAtRef.current = Date.now();
            }
            return;
          }

          lastRefreshAtRef.current = Date.now();
          const attentionLevels = Object.fromEntries(
            updated.sessions.map((s) => [s.id, getAttentionLevel(s, attentionZones)]),
          ) as AttentionMap;
          dispatch({
            type: "reset",
            sessions: updated.sessions,
            attentionLevels,
            liveResolved: true,
          });
        })
        .catch((err: unknown) => {
          if (pageUnloadingRef.current || refreshController.signal.aborted || isAbortLikeError(err))
            return;
          console.warn("[useSessionEvents] refresh failed:", err);
          dispatch({ type: "refreshError", error: getErrorMessage(err) });
          // Update timestamp on failure to prevent retry loops
          lastRefreshAtRef.current = Date.now();
        })
        .finally(() => {
          if (activeRefreshControllerRef.current === refreshController) {
            activeRefreshControllerRef.current = null;
          }
          if (refreshController.signal.aborted) {
            // If there's still a pending membership change, reschedule so it isn't lost
            if (pendingMembershipKeyRef.current !== null) {
              scheduleRefresh();
            }
            return;
          }

          if (
            pendingMembershipKeyRef.current !== null &&
            pendingMembershipKeyRef.current !== requestedMembershipKey
          ) {
            scheduleRefresh();
            return;
          }

          pendingMembershipKeyRef.current = null;
        });
    }, MEMBERSHIP_REFRESH_DELAY_MS);
  }, [project, attentionZones]);

  // Sync mux session-fetch errors into reducer state. Successful snapshots clear
  // these flags, so transient errors don't stay visible until muxLastError flips.
  useEffect(() => {
    if (disabled) return;
    if (muxLastError) {
      dispatch({ type: "muxError", error: muxLastError });
    } else {
      dispatch({ type: "clearErrors" });
    }
  }, [disabled, muxLastError]);

  // Mux-based session updates (replaces SSE when available)
  useEffect(() => {
    if (disabled || !muxSessions) return;
    // Note: empty array is intentional — it means all sessions were removed and we
    // must still run the membership-key comparison to trigger scheduleRefresh().

    // muxSessions is global (all projects). Filter to only sessions in the
    // current project-scoped state so we don't trigger spurious refreshes
    // when viewing a single-project page.
    const currentIds = new Set(sessionsRef.current.map((s) => s.id));
    const scopedMuxSessions = muxSessions.filter((s) => currentIds.has(s.id));
    // The mux feed is global, but the page is project-scoped. We can't tell from
    // a mux patch whether an unknown ID belongs to this project — only /api/sessions
    // knows. So if we see ANY id we don't have, trigger a refresh to find out.
    const hasUnknownIds = muxSessions.some((s) => !currentIds.has(s.id));

    dispatch({ type: "snapshot", patches: scopedMuxSessions as SessionPatch[] });

    const currentMembershipKey = createMembershipKey(sessionsRef.current);
    const snapshotMembershipKey = createMembershipKey(scopedMuxSessions);

    if (hasUnknownIds || currentMembershipKey !== snapshotMembershipKey) {
      pendingMembershipKeyRef.current = snapshotMembershipKey;
      scheduleRefresh();
    } else if (Date.now() - lastRefreshAtRef.current >= STALE_REFRESH_INTERVAL_MS) {
      scheduleRefresh();
    }

    return () => {
      // Only abort in-flight requests — do NOT clear the debounce timer.
      // Cancelling the timer here would prevent the membership-change refresh
      // from completing when muxSessions updates arrive in rapid succession.
      activeRefreshControllerRef.current?.abort();
      activeRefreshControllerRef.current = null;
    };
  }, [disabled, muxSessions, scheduleRefresh]);

  // Unmount-only cleanup: clear the debounce timer to prevent leaks.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      activeRefreshControllerRef.current?.abort();
      activeRefreshControllerRef.current = null;
    };
  }, []);

  return state;
}
