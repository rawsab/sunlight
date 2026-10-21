import type { AmbientDebugMetrics, AmbientFrameEvent, AmbientSettings, AmbientStatus } from "./types";
import {
  ambientGetStatus,
  ambientStart,
  ambientStop,
  ambientUpdateSettings,
  listenAmbientDebugMetrics,
  listenAmbientFrame,
  listenAmbientNotice,
  listenAmbientStatus,
  listenAmbientStopped,
  type AmbientStopReason,
  type AmbientStoppedEvent,
} from "./ambientApi";

export interface PreAmbientState {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

interface AmbientRunnerCallbacks {
  onColorChange: (color: { r: number; g: number; b: number }) => void;
  onStatusChange: (status: AmbientStatus) => void;
  onFrameMetrics?: (frame: AmbientFrameEvent) => void;
  onDebugMetrics?: (metrics: AmbientDebugMetrics) => void;
  onStopped?: (reason: AmbientStopReason, message?: string) => void;
  onNotice?: (message: string) => void;
  getConnected: () => boolean;
  capturePreAmbientState?: () => PreAmbientState;
  onRestorePreAmbient?: (state: PreAmbientState) => void;
}

let callbacks: AmbientRunnerCallbacks | null = null;
let running = false;
let stopping = false;
let listenersReady = false;
let unlisteners: Array<() => void> = [];
let preAmbientState: PreAmbientState | null = null;
let lastFrameAt = 0;
let statusWatchdog: ReturnType<typeof setInterval> | null = null;

const FRAME_STALE_MS = 15_000;
const STATUS_SYNC_INTERVAL_MS = 5_000;

function isActiveAmbientStatus(status: AmbientStatus): boolean {
  return status === "running" || status === "starting_capture";
}

function startStatusWatchdog(): void {
  if (statusWatchdog) return;
  statusWatchdog = setInterval(() => {
    if (!running || stopping) return;
    const frameStale = lastFrameAt > 0 && Date.now() - lastFrameAt > FRAME_STALE_MS;
    if (!frameStale) return;
    void syncAmbientStatus().then((status) => {
      if (!isActiveAmbientStatus(status)) {
        running = false;
        callbacks?.onStatusChange(status);
      }
    });
  }, STATUS_SYNC_INTERVAL_MS);
}

function stopStatusWatchdog(): void {
  if (statusWatchdog) {
    clearInterval(statusWatchdog);
    statusWatchdog = null;
  }
}

export function initAmbientRunner(cbs: AmbientRunnerCallbacks): void {
  callbacks = cbs;
  void setupListeners();
}

async function setupListeners(): Promise<void> {
  if (listenersReady) return;
  listenersReady = true;

  const unsubs = await Promise.all([
    listenAmbientFrame((frame) => {
      if (!running || stopping) return;
      lastFrameAt = Date.now();
      callbacks?.onColorChange({ r: frame.r, g: frame.g, b: frame.b });
      callbacks?.onFrameMetrics?.(frame);
    }),
    listenAmbientDebugMetrics((metrics) => {
      if (!running || stopping) return;
      callbacks?.onDebugMetrics?.(metrics);
    }),
    listenAmbientStatus((status) => {
      if (stopping) {
        if (status === "stopped" || status === "inactive" || status === "failed") {
          running = false;
        }
        return;
      }
      if (!running && isActiveAmbientStatus(status)) return;
      running = isActiveAmbientStatus(status);
      callbacks?.onStatusChange(status);
      if (status === "stopped" || status === "inactive" || status === "failed") {
        running = false;
        stopStatusWatchdog();
      }
      if (isActiveAmbientStatus(status)) {
        startStatusWatchdog();
      }
    }),
    listenAmbientStopped((event: AmbientStoppedEvent) => {
      running = false;
      stopping = false;
      stopStatusWatchdog();
      callbacks?.onStatusChange("stopped");
      if (event.reason !== "user") {
        preAmbientState = null;
      }
      callbacks?.onStopped?.(event.reason, event.message);
    }),
    listenAmbientNotice((message) => {
      callbacks?.onNotice?.(message);
    }),
  ]);

  unlisteners = unsubs;
}

export function isAmbientRunning(): boolean {
  return running && !stopping;
}

export async function startAmbient(
  settings: AmbientSettings,
  brightness: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!callbacks) return { ok: false, error: "Ambient runner not initialized." };
  if (!callbacks.getConnected()) {
    return { ok: false, error: "Connect to the selected lamp before starting Ambient Mode." };
  }

  stopping = false;
  lastFrameAt = Date.now();

  try {
    await ambientStart(settings, brightness);
    preAmbientState = callbacks.capturePreAmbientState?.() ?? null;
    running = true;
    startStatusWatchdog();
    return { ok: true };
  } catch (e: unknown) {
    running = false;
    stopping = false;
    preAmbientState = null;
    stopStatusWatchdog();
    callbacks.onStatusChange("failed");
    const message =
      typeof e === "string"
        ? e
        : "Could not start Ambient Mode. Check Screen Recording permission and try again.";
    return { ok: false, error: message };
  }
}

export async function stopAmbient(reason: AmbientStopReason = "user"): Promise<void> {
  stopping = true;
  running = false;
  stopStatusWatchdog();
  callbacks?.onStatusChange("stopped");

  try {
    await ambientStop();
  } catch {
    // Backend may already be stopped; still clear frontend state.
  } finally {
    stopping = false;
  }

  if (reason === "user" && preAmbientState && callbacks?.onRestorePreAmbient) {
    callbacks.onRestorePreAmbient(preAmbientState);
  }
  preAmbientState = null;
}

export function updateAmbientSettings(
  settings: AmbientSettings,
  brightness?: number
): void {
  if (!running || stopping) return;
  void ambientUpdateSettings(settings, brightness).catch(() => {});
}

export async function syncAmbientStatus(): Promise<AmbientStatus> {
  const status = await ambientGetStatus();
  if (!stopping) {
    running = isActiveAmbientStatus(status);
    callbacks?.onStatusChange(status);
    if (!running) {
      stopStatusWatchdog();
    }
  }
  return status;
}

export function teardownAmbientRunner(): void {
  for (const unlisten of unlisteners) unlisten();
  unlisteners = [];
  listenersReady = false;
  running = false;
  stopping = false;
  preAmbientState = null;
  stopStatusWatchdog();
  lastFrameAt = 0;
}
