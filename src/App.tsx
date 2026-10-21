import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save, open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Settings } from "lucide-react";
import type {
  AmbientConfig,
  AmbientDebugMetrics,
  AmbientSettings,
  AmbientStatus,
  AppState,
  ConnectionStatus,
  LampLoop,
  LampPreset,
  LoopSection,
  PresetSection,
  WorkspaceTab,
} from "./types";
import { DEFAULT_AMBIENT_SETTINGS } from "./types";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { ColorControlPanel } from "./components/ColorControlPanel";
import { RightWorkspacePanel } from "./components/RightWorkspacePanel";
import { PresetEditorModal } from "./components/PresetEditorModal";
import { SettingsModal } from "./components/SettingsModal";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Toast, useToast } from "./components/Toast";
import { loadAppState, saveAppState } from "./storage";
import { createFreshAppState } from "./migrateState";
import { seedDefaults } from "./presets";
import { seedLoopDefaults } from "./loops";
import { clearThrottledSends, connectLamp } from "./lampApi";
import { animateColorTransition, cancelTransition } from "./transition";
import {
  canSend,
  formatConnectionError,
  initConnectionManager,
  safeSetColor,
  verifyOnResume,
} from "./connectionManager";
import {
  initLoopRunner,
  startLoop,
  stopLoop,
  getActiveLoopId,
} from "./loopRunner";
import {
  initAmbientRunner,
  isAmbientRunning,
  startAmbient,
  stopAmbient,
  syncAmbientStatus,
  updateAmbientSettings,
  teardownAmbientRunner,
} from "./ambientRunner";
import {
  buildExportBundle,
  ensureJsonExtension,
  getDefaultExportFilename,
  parseImportJson,
} from "./exportImport";

type ConfirmState =
  | { type: "import"; data: AppState }
  | { type: "resetPresets" }
  | null;

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [r, setR] = useState(255);
  const [g, setG] = useState(128);
  const [b, setB] = useState(0);
  const [brightness, setBrightness] = useState(64);
  const [liveUpdate, setLiveUpdate] = useState(true);
  const [autoConnect, setAutoConnect] = useState(false);
  const [transitionEnabled, setTransitionEnabled] = useState(true);
  const [transitionDurationMs, setTransitionDurationMs] = useState(1200);
  const [workspace, setWorkspace] = useState<WorkspaceTab>("presets");
  const [presets, setPresets] = useState<LampPreset[]>([]);
  const [sections, setSections] = useState<PresetSection[]>([]);
  const [loops, setLoops] = useState<LampLoop[]>([]);
  const [loopSections, setLoopSections] = useState<LoopSection[]>([]);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [activeLoopId, setActiveLoopId] = useState<string | null>(null);
  const [runningLoopId, setRunningLoopId] = useState<string | null>(null);
  const [runningLoopName, setRunningLoopName] = useState<string | null>(null);
  const [ambientSettings, setAmbientSettings] = useState<AmbientSettings>(DEFAULT_AMBIENT_SETTINGS);
  const [ambientConfigs, setAmbientConfigs] = useState<AmbientConfig[]>([]);
  const [ambientConfigOrder, setAmbientConfigOrder] = useState<string[]>([]);
  const [ambientStatus, setAmbientStatus] = useState<AmbientStatus>("inactive");
  const [ambientDebugMetrics, setAmbientDebugMetrics] =
    useState<AmbientDebugMetrics | null>(null);
  const [ambientBrightness, setAmbientBrightness] = useState<number | null>(null);
  const [saveCurrentModal, setSaveCurrentModal] = useState(false);
  const powerBusyRef = useRef(false);
  const lastOnBrightnessRef = useRef(64);
  const [powerBusy, setPowerBusy] = useState(false);
  const [deviceName, setDeviceName] = useState("SSL-99A4C3");
  const [deviceId, setDeviceId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [loaded, setLoaded] = useState(false);
  const { toast, showToast } = useToast();

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const colorRef = useRef({ r, g, b, brightness });
  const transitionSettingsRef = useRef({ transitionEnabled, transitionDurationMs });
  const statusRef = useRef(status);
  const autoConnectRef = useRef(autoConnect);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ambientUpdatingRef = useRef(false);
  const ambientSettingsRef = useRef(ambientSettings);
  const brightnessRef = useRef(brightness);

  useEffect(() => {
    colorRef.current = { r, g, b, brightness };
  }, [r, g, b, brightness]);

  useEffect(() => {
    transitionSettingsRef.current = { transitionEnabled, transitionDurationMs };
  }, [transitionEnabled, transitionDurationMs]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    autoConnectRef.current = autoConnect;
  }, [autoConnect]);

  useEffect(() => {
    ambientSettingsRef.current = ambientSettings;
  }, [ambientSettings]);

  useEffect(() => {
    brightnessRef.current = brightness;
    if (
      isAmbientRunning() &&
      ambientSettingsRef.current.brightnessMode === "manual"
    ) {
      updateAmbientSettings(ambientSettingsRef.current, brightness);
    }
  }, [brightness]);

  useEffect(() => {
    initConnectionManager({
      getStatus: () => statusRef.current,
      setStatus,
      setError,
      getAutoConnect: () => autoConnectRef.current,
    });

    initLoopRunner({
      onColorChange: (color) => {
        setR(color.r);
        setG(color.g);
        setB(color.b);
        setBrightness(color.brightness);
        setActivePresetId(null);
      },
      onRunningChange: (loopId, loopName) => {
        setRunningLoopId(loopId);
        setRunningLoopName(loopName ?? null);
        setActiveLoopId(loopId);
        if (!loopId) setActiveLoopId(null);
      },
      onStopped: (reason) => {
        if (reason === "connection_lost" || reason === "disconnect") {
          showToast("Loop stopped — connection lost.", "error");
        }
      },
      getConnected: () => statusRef.current === "connected",
    });

    initAmbientRunner({
      onColorChange: (color) => {
        ambientUpdatingRef.current = true;
        setR(color.r);
        setG(color.g);
        setB(color.b);
        setActivePresetId(null);
        setActiveLoopId(null);
        requestAnimationFrame(() => {
          ambientUpdatingRef.current = false;
        });
      },
      onStatusChange: setAmbientStatus,
      onFrameMetrics: (frame) => {
        if (frame.computedBrightness != null) {
          setAmbientBrightness(frame.computedBrightness);
        }
      },
      onDebugMetrics: (metrics) => {
        setAmbientDebugMetrics(metrics);
      },
      capturePreAmbientState: () => ({
        r: colorRef.current.r,
        g: colorRef.current.g,
        b: colorRef.current.b,
        brightness: colorRef.current.brightness,
      }),
      onRestorePreAmbient: (state) => {
        setR(state.r);
        setG(state.g);
        setB(state.b);
        setBrightness(state.brightness);
        setAmbientBrightness(null);
        if (statusRef.current === "connected") {
          void safeSetColor(state.r, state.g, state.b, state.brightness);
        }
      },
      onStopped: (reason, message) => {
        setAmbientBrightness(null);
        setAmbientDebugMetrics(null);
        if (reason === "connection_lost") {
          void verifyOnResume();
          showToast(
            message ??
              "Ambient Mode stopped because the lamp connection became stale.",
            "error"
          );
        } else if (reason === "capture_failed") {
          showToast(
            message ??
              "Could not capture the screen. Check Screen Recording permission and try again.",
            "error"
          );
        } else if (reason === "permission") {
          showToast(message ?? "Screen Recording permission is required.", "error");
        }
      },
      onNotice: (message) => showToast(message),
      getConnected: () => statusRef.current === "connected",
    });

    void syncAmbientStatus();
  }, [showToast]);

  useEffect(() => {
    if (status !== "connected") {
      if (getActiveLoopId()) {
        stopLoop(status === "disconnected" ? "disconnect" : "connection_lost");
      }
      if (isAmbientRunning()) {
        void stopAmbient(status === "disconnected" ? "disconnect" : "connection_lost");
      }
    }
  }, [status]);

  const scheduleVerifyOnResume = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      void verifyOnResume();
      if (isAmbientRunning()) {
        void syncAmbientStatus();
      }
    }, 500);
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleVerifyOnResume();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    let unlistenFocus: (() => void) | undefined;
    void getCurrentWindow()
      .listen("tauri://focus", scheduleVerifyOnResume)
      .then((fn) => {
        unlistenFocus = fn;
      })
      .catch(() => {});

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlistenFocus?.();
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
      stopLoop("user");
      void stopAmbient("user");
      teardownAmbientRunner();
    };
  }, [scheduleVerifyOnResume]);

  useEffect(() => {
    (async () => {
      const state = await loadAppState();
      if (state) {
        setR(state.settings.lastColor.r);
        setG(state.settings.lastColor.g);
        setB(state.settings.lastColor.b);
        setBrightness(state.settings.lastColor.brightness);
        setLiveUpdate(state.settings.liveUpdate);
        setDeviceName(state.settings.deviceName);
        setDeviceId(state.settings.deviceId);
        setAutoConnect(state.settings.autoConnect);
        setTransitionEnabled(state.settings.transitionEnabled ?? true);
        setTransitionDurationMs(state.settings.transitionDurationMs ?? 1200);
        setAmbientSettings(state.settings.ambient ?? DEFAULT_AMBIENT_SETTINGS);
        setAmbientConfigs(state.ambientConfigs ?? []);
        setAmbientConfigOrder(state.ambientConfigOrder ?? []);
        setWorkspace("presets");
        setPresets(state.presets);
        setSections(state.sections);
        setLoops(state.loops);
        setLoopSections(state.loopSections);

        if (state.settings.autoConnect) {
          setStatus("scanning");
          try {
            await connectLamp();
            setStatus("connected");
          } catch (e: unknown) {
            setStatus("failed");
            setError(formatConnectionError(e));
          }
        }
      } else {
        const fresh = createFreshAppState();
        setWorkspace("presets");
        setAmbientSettings(fresh.settings.ambient ?? DEFAULT_AMBIENT_SETTINGS);
        setAmbientConfigs(fresh.ambientConfigs ?? []);
        setAmbientConfigOrder(fresh.ambientConfigOrder ?? []);
        setPresets(fresh.presets);
        setSections(fresh.sections);
        setLoops(fresh.loops);
        setLoopSections(fresh.loopSections);
      }
      setLoaded(true);
    })();
  }, []);

  const doPersist = useCallback(() => {
    if (!loaded) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const state: AppState = {
        schemaVersion: 2,
        settings: {
          deviceName,
          deviceId,
          autoConnect,
          liveUpdate,
          transitionEnabled,
          transitionDurationMs,
          ambient: ambientSettings,
          lastColor: { r, g, b, brightness },
        },
        sections,
        presets,
        loopSections,
        loops,
        ambientConfigs,
        ambientConfigOrder,
      };
      saveAppState(state);
    }, 500);
  }, [
    loaded,
    deviceName,
    deviceId,
    autoConnect,
    liveUpdate,
    transitionEnabled,
    transitionDurationMs,
    ambientSettings,
    r,
    g,
    b,
    brightness,
    sections,
    presets,
    loopSections,
    loops,
    ambientConfigs,
    ambientConfigOrder,
  ]);

  useEffect(() => {
    doPersist();
  }, [doPersist]);

  const handlePowerChange = async (on: boolean) => {
    if (powerBusyRef.current || statusRef.current !== "connected") return;
    powerBusyRef.current = true;
    setPowerBusy(true);
    try {
      stopLoop("manual_color");
      cancelTransition();
      clearThrottledSends();
      await stopAmbient("manual_color");
      // Clear any trailing color update before sending the power change.
      cancelTransition();
      clearThrottledSends();
      const color = colorRef.current;
      if (color.brightness > 0) lastOnBrightnessRef.current = color.brightness;
      const nextBrightness = on ? (color.brightness || lastOnBrightnessRef.current) : 0;
      const result = await safeSetColor(color.r, color.g, color.b, nextBrightness);
      if (result.sent) {
        setBrightness(nextBrightness);
        setActivePresetId(null);
        setActiveLoopId(null);
        setError(null);
      } else {
        setError("Could not change lamp power. Check the connection and try again.");
      }
    } catch (e) {
      setError(formatConnectionError(e));
    } finally {
      powerBusyRef.current = false;
      setPowerBusy(false);
    }
  };

  const handleColorChange = (nr: number, ng: number, nb: number, nbr: number) => {
    if (ambientUpdatingRef.current) {
      setR(nr);
      setG(ng);
      setB(nb);
      setBrightness(nbr);
      return;
    }
    if (isAmbientRunning()) void stopAmbient("manual_color");
    if (getActiveLoopId()) stopLoop("manual_color");
    cancelTransition();
    setR(nr);
    setG(ng);
    setB(nb);
    setBrightness(nbr);
    setActivePresetId(null);
    setActiveLoopId(null);
  };

  const handleActivatePreset = async (preset: LampPreset) => {
    if (isAmbientRunning()) await stopAmbient("preset");
    if (getActiveLoopId()) stopLoop("preset");
    cancelTransition();
    setActivePresetId(preset.id);
    setActiveLoopId(null);

    const from = colorRef.current;
    const to = {
      r: preset.r,
      g: preset.g,
      b: preset.b,
      brightness: preset.brightness,
    };
    const { transitionEnabled: enabled, transitionDurationMs: durationMs } =
      transitionSettingsRef.current;
    const connected = statusRef.current === "connected";

    if (enabled && durationMs > 0) {
      animateColorTransition(
        from,
        to,
        durationMs,
        (color) => {
          setR(color.r);
          setG(color.g);
          setB(color.b);
          setBrightness(color.brightness);
        },
        { sendToLamp: connected, canSend }
      );
      return;
    }

    setR(to.r);
    setG(to.g);
    setB(to.b);
    setBrightness(to.brightness);
    if (connected) void safeSetColor(to.r, to.g, to.b, to.brightness);
  };

  const handleRunLoop = async (loop: LampLoop) => {
    if (getActiveLoopId() === loop.id) return;
    if (isAmbientRunning()) await stopAmbient("loop");
    cancelTransition();
    setActivePresetId(null);
    const result = startLoop(loop);
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    showToast(`Running "${loop.name}"`);
  };

  const handleStopLoop = () => {
    stopLoop("user");
    showToast("Loop stopped.");
  };

  const handleLoopEdited = (loopId: string) => {
    if (getActiveLoopId() === loopId) {
      stopLoop("edited");
      showToast("Loop stopped — edit saved. Run again to play changes.");
    }
  };

  const handleSavePreset = (preset: LampPreset, sectionId: string) => {
    const isEdit = presets.some((p) => p.id === preset.id);
    let newPresets: LampPreset[];
    let newSections = [...sections];

    if (isEdit) {
      newPresets = presets.map((p) => (p.id === preset.id ? preset : p));
      const oldSection = sections.find((s) => s.presetIds.includes(preset.id));
      if (oldSection && oldSection.id !== sectionId) {
        newSections = newSections.map((s) => {
          if (s.id === oldSection.id) return { ...s, presetIds: s.presetIds.filter((id) => id !== preset.id) };
          if (s.id === sectionId) return { ...s, presetIds: [...s.presetIds, preset.id] };
          return s;
        });
      }
    } else {
      newPresets = [...presets, preset];
      newSections = newSections.map((s) =>
        s.id === sectionId ? { ...s, presetIds: [...s.presetIds, preset.id] } : s
      );
    }

    setPresets(newPresets);
    setSections(newSections);
    setSaveCurrentModal(false);
  };

  const handleStartAmbient = async () => {
    if (isAmbientRunning()) return;
    if (getActiveLoopId()) stopLoop("ambient");
    cancelTransition();
    setActivePresetId(null);
    setActiveLoopId(null);
    const result = await startAmbient(ambientSettingsRef.current, brightnessRef.current);
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    showToast("Ambient Mode started.");
  };

  const handleStopAmbient = async () => {
    await stopAmbient("user");
    setAmbientDebugMetrics(null);
    showToast("Ambient Mode stopped.");
  };

  const handleAmbientSettingsChange = (next: AmbientSettings) => {
    setAmbientSettings(next);
    if (isAmbientRunning()) {
      const b = next.brightnessMode === "manual" ? brightnessRef.current : undefined;
      updateAmbientSettings(next, b);
    }
  };

  const applyImportedState = (data: AppState) => {
    void stopAmbient("import");
    stopLoop("import");
    setR(data.settings.lastColor.r);
    setG(data.settings.lastColor.g);
    setB(data.settings.lastColor.b);
    setBrightness(data.settings.lastColor.brightness);
    setLiveUpdate(data.settings.liveUpdate);
    setAutoConnect(data.settings.autoConnect);
    setTransitionEnabled(data.settings.transitionEnabled);
    setTransitionDurationMs(data.settings.transitionDurationMs);
    setAmbientSettings(data.settings.ambient ?? DEFAULT_AMBIENT_SETTINGS);
    setAmbientConfigs(data.ambientConfigs ?? []);
    setAmbientConfigOrder(data.ambientConfigOrder ?? []);
    setWorkspace(data.settings.activeWorkspace ?? "presets");
    setPresets(data.presets);
    setSections(data.sections);
    setLoops(data.loops);
    setLoopSections(data.loopSections);
    setActivePresetId(null);
    setActiveLoopId(null);
    void saveAppState({ ...data, settings: { ...data.settings, deviceName, deviceId } });
  };

  const handleExport = async () => {
    try {
      const state: AppState = {
        schemaVersion: 2,
        settings: {
          deviceName,
          deviceId,
          autoConnect,
          liveUpdate,
          transitionEnabled,
          transitionDurationMs,
          ambient: ambientSettings,
          lastColor: { r, g, b, brightness },
        },
        sections,
        presets,
        loopSections,
        loops,
        ambientConfigs,
        ambientConfigOrder,
      };
      const bundle = buildExportBundle(state);
      const path = await save({
        title: "Export Configuration",
        defaultPath: getDefaultExportFilename(),
        filters: [{ name: "JSON backup", extensions: ["json"] }],
      });
      if (!path) return;
      const exportPath = ensureJsonExtension(path);
      await writeTextFile(exportPath, JSON.stringify(bundle, null, 2));
      showToast("Configuration exported successfully.");
    } catch (e) {
      console.error("Export failed:", e);
      showToast("Failed to export configuration.", "error");
    }
  };

  const handleImportPick = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || Array.isArray(path)) return;
      const text = await readTextFile(path);
      const result = parseImportJson(text);
      if (!result.ok) {
        showToast(result.error, "error");
        return;
      }
      setConfirm({ type: "import", data: result.data });
    } catch {
      showToast("Failed to read backup file.", "error");
    }
  };

  const handleResetPresets = () => {
    setConfirm({ type: "resetPresets" });
  };

  const connected = status === "connected";
  const recovering = status === "stale" || status === "reconnecting";

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 rounded-full border-2 border-[#ff8040]/30 border-t-[#ff8040] animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#111114]">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e1e24] flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full bg-[#ff8040]" />
          <h1 className="text-sm font-semibold text-[#f0f0f4]">Sunlight</h1>
          {runningLoopName && (
            <span className="text-[10px] text-[#60a5fa] hidden sm:inline">
              ↺ {runningLoopName}
            </span>
          )}
          {isAmbientRunning() && !runningLoopName && (
            <span className="text-[10px] text-[#34d399] hidden sm:inline">◉ Ambient</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
              )}
              {recovering && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  connected
                    ? "bg-green-400"
                    : recovering
                      ? "bg-amber-400"
                      : status === "failed"
                        ? "bg-red-400"
                        : "bg-[#555568]"
                }`}
              />
            </span>
            <span className="text-[11px] font-mono text-[#555568]">{deviceName}</span>
          </div>

          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg p-1.5 text-[#555568] hover:text-[#9090a0] hover:bg-[#1e1e24] transition-colors"
            title="Settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 gap-0">
        <div className="w-72 flex-shrink-0 border-r border-[#1e1e24] flex flex-col overflow-y-auto p-4 gap-3">
          <ConnectionPanel
            status={status}
            onStatusChange={setStatus}
            error={error}
            onError={setError}
          />
          <ColorControlPanel
            powerBusy={powerBusy}
            onPowerChange={handlePowerChange}
            r={r}
            g={g}
            b={b}
            brightness={brightness}
            status={status}
            liveUpdate={liveUpdate}
            onLiveUpdateChange={setLiveUpdate}
            onColorChange={handleColorChange}
            onSaveAsPreset={() => setSaveCurrentModal(true)}
          />
          {runningLoopName && (
            <div className="rounded-xl border border-[#60a5fa]/30 bg-[#60a5fa]/5 px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-[#60a5fa] truncate">Loop: {runningLoopName}</span>
              <button
                onClick={handleStopLoop}
                className="text-[10px] font-medium text-[#f87171] hover:underline flex-shrink-0 ml-2"
              >
                Stop
              </button>
            </div>
          )}
          {isAmbientRunning() && !runningLoopName && (
            <div className="rounded-xl border border-[#34d399]/30 bg-[#34d399]/5 px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-[#34d399] truncate">Ambient Mode active</span>
              <button
                onClick={handleStopAmbient}
                className="text-[10px] font-medium text-[#f87171] hover:underline flex-shrink-0 ml-2"
              >
                Stop
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 p-4 overflow-hidden flex flex-col">
          <RightWorkspacePanel
            workspace={workspace}
            onWorkspaceChange={setWorkspace}
            presets={presets}
            sections={sections}
            loops={loops}
            loopSections={loopSections}
            activePresetId={activePresetId}
            activeLoopId={activeLoopId}
            runningLoopId={runningLoopId}
            runningLoopName={runningLoopName}
            ambientRunning={isAmbientRunning()}
            ambientStatus={ambientStatus}
            ambientSettings={ambientSettings}
            onAmbientSettingsChange={handleAmbientSettingsChange}
            ambientConfigs={ambientConfigs}
            ambientConfigOrder={ambientConfigOrder}
            onAmbientConfigsChange={setAmbientConfigs}
            onAmbientConfigOrderChange={setAmbientConfigOrder}
            ambientDebugMetrics={ambientDebugMetrics}
            ambientBrightness={ambientBrightness}
            manualBrightness={brightness}
            onStartAmbient={() => void handleStartAmbient()}
            onStopAmbient={handleStopAmbient}
            currentR={r}
            currentG={g}
            currentB={b}
            currentBrightness={brightness}
            connected={connected}
            onActivatePreset={handleActivatePreset}
            onRunLoop={handleRunLoop}
            onStopLoop={handleStopLoop}
            onPresetsChange={setPresets}
            onSectionsChange={setSections}
            onLoopsChange={(newLoops) => {
              if (getActiveLoopId() && !newLoops.some((l) => l.id === getActiveLoopId())) {
                stopLoop("deleted");
              }
              setLoops(newLoops);
            }}
            onLoopSectionsChange={setLoopSections}
            onLoopEdited={handleLoopEdited}
            onToast={showToast}
          />
        </div>
      </div>

      <PresetEditorModal
        open={saveCurrentModal}
        sections={sections}
        defaultSectionId={sections[0]?.id ?? ""}
        currentR={r}
        currentG={g}
        currentB={b}
        currentBrightness={brightness}
        connected={connected}
        onSave={handleSavePreset}
        onCancel={() => setSaveCurrentModal(false)}
      />

      <SettingsModal
        open={settingsOpen}
        deviceName={deviceName}
        deviceId={deviceId}
        connectionBusy={status === "scanning" || status === "connecting" || status === "reconnecting"}
        onLampChange={(id, name) => { stopLoop("disconnect"); setDeviceId(id); setDeviceName(name); setStatus("disconnected"); setError(null); }}
        autoConnect={autoConnect}
        onAutoConnectChange={setAutoConnect}
        transitionEnabled={transitionEnabled}
        onTransitionEnabledChange={setTransitionEnabled}
        transitionDurationMs={transitionDurationMs}
        onTransitionDurationChange={setTransitionDurationMs}
        onExport={handleExport}
        onImport={handleImportPick}
        onResetPresets={handleResetPresets}
        onClose={() => setSettingsOpen(false)}
      />

      <ConfirmDialog
        open={confirm?.type === "import"}
        title="Import configuration?"
        message="This will replace your current presets, loops, sections, and settings with the backup file."
        confirmLabel="Import"
        danger
        onConfirm={() => {
          if (confirm?.type === "import") {
            applyImportedState(confirm.data);
            showToast("Configuration imported successfully.");
          }
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm?.type === "resetPresets"}
        title="Reset to defaults?"
        message="This will restore default presets and loops. Your app settings (auto-connect, transitions, etc.) will be kept."
        confirmLabel="Reset"
        danger
        onConfirm={() => {
          void stopAmbient("reset");
          stopLoop("reset");
          const { presets: defaultPresets, sections: defaultSections } = seedDefaults();
          const { loops: defaultLoops, loopSections: defaultLoopSections } = seedLoopDefaults();
          setPresets(defaultPresets);
          setSections(defaultSections);
          setLoops(defaultLoops);
          setLoopSections(defaultLoopSections);
          setAmbientSettings(DEFAULT_AMBIENT_SETTINGS);
          setActivePresetId(null);
          setActiveLoopId(null);
          setWorkspace("presets");
          showToast("Presets and loops reset to defaults.");
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />

      <Toast toast={toast} />
    </div>
  );
}
