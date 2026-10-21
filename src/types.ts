export type ConnectionStatus =
  | "disconnected"
  | "scanning"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stale"
  | "failed";

export type WorkspaceTab = "presets" | "loops" | "ambient";

export type AmbientQuality = "performance" | "balanced" | "responsive_detail";
export type AmbientFixedOutputFps = 4 | 8 | 10 | 12 | 15 | 20 | 25 | 30;
export type AmbientOutputRate = AmbientFixedOutputFps | "adaptive_max";
/** @deprecated Use AmbientOutputRate */
export type AmbientOutputFps = AmbientFixedOutputFps;
export type AmbientEdgePriority = "low" | "medium" | "high";
export type AmbientBrightnessMode = "manual" | "dynamic";
export type AmbientBrightnessResponse = "dimmer" | "balanced" | "brighter";

export type AmbientStatus =
  | "inactive"
  | "checking_permission"
  | "waiting_for_permission"
  | "starting_capture"
  | "running"
  | "stopped"
  | "failed";

export interface AmbientSettings {
  quality: AmbientQuality;
  outputFps: AmbientOutputRate;
  edgePriority: AmbientEdgePriority;
  saturationBoost: number;
  brightnessBoost: number;
  responsiveness: number;
  minColorDelta: number;
  debug: boolean;
  brightnessMode: AmbientBrightnessMode;
  brightnessResponse: AmbientBrightnessResponse;
  brightnessResponseFineTune: number;
  blackThreshold: number;
  minActiveBrightness: number;
  maxBrightness: number;
  brightnessSmoothing: number;
  centerContribution: number;
  highlightInfluence: number;
}

export const DEFAULT_AMBIENT_SETTINGS: AmbientSettings = {
  quality: "balanced",
  outputFps: 8,
  edgePriority: "high",
  saturationBoost: 1.4,
  brightnessBoost: 1.15,
  responsiveness: 0.5,
  minColorDelta: 10,
  debug: false,
  brightnessMode: "dynamic",
  brightnessResponse: "dimmer",
  brightnessResponseFineTune: 0.5,
  blackThreshold: 0.06,
  minActiveBrightness: 4,
  maxBrightness: 64,
  brightnessSmoothing: 0.22,
  centerContribution: 0.15,
  highlightInfluence: 0.3,
};

export const MOVIE_AMBIENT_SETTINGS: AmbientSettings = {
  quality: "responsive_detail",
  outputFps: 30,
  edgePriority: "high",
  saturationBoost: 2,
  brightnessBoost: 1.1,
  responsiveness: 0.85,
  minColorDelta: 10,
  debug: true,
  brightnessMode: "dynamic",
  brightnessResponse: "balanced",
  brightnessResponseFineTune: 1,
  blackThreshold: 0.14,
  minActiveBrightness: 1,
  maxBrightness: 64,
  brightnessSmoothing: 0.6,
  centerContribution: 0.22,
  highlightInfluence: 0.24,
};

export interface AmbientConfig {
  id: string;
  name: string;
  settings: AmbientSettings;
  createdAt: string;
  updatedAt: string;
}

export interface AmbientFrameEvent {
  r: number;
  g: number;
  b: number;
  hex: string;
  computedBrightness?: number;
  screenIntensity?: number;
}

export interface AmbientDebugMetrics {
  captureFps: number;
  targetCaptureFps?: number;
  captureTimeMsAvg: number;
  captureTimeMsLast: number;
  captureFailures: number;
  processingTimeMsAvg: number;
  processingTimeMsLast: number;
  downsampleTimeMsAvg?: number;
  algorithmTimeMsAvg?: number;
  targetOutputFps: number;
  actualOutputFps: number;
  outputIntervalMsAvg: number;
  timeSinceLastFrameMs: number;
  timeSinceLastBleSendMs: number;
  bleWriteTimeMsAvg: number;
  bleWriteTimeMsLast: number;
  bleWriteFailures: number;
  bleWritesInFlight?: number;
  bleBusySkips?: number;
  skippedDueToDelta: number;
  skippedDueToRateLimit: number;
  skippedDueToDuplicate: number;
  skippedDueToStaleConnection: number;
  droppedFrames?: number;
  colorDeltaLast: number;
  brightnessDeltaLast: number;
  computedBrightness: number;
  screenIntensity: number;
  edgeIntensity?: number;
  centerIntensity?: number;
  spatialIntensity?: number;
  highlightIntensity?: number;
  smoothedBrightness?: number;
  targetBrightness?: number;
  brightnessMode?: AmbientBrightnessMode;
  blackThreshold?: number;
  centerContribution?: number;
  highlightInfluence?: number;
  adaptiveModeEnabled?: boolean;
  adaptiveTargetFps?: number;
  adaptiveCaptureTargetFps?: number;
  adaptiveOutputTargetFps?: number;
  adaptiveState?: "warming_up" | "stable" | "increasing" | "decreasing" | "limited";
  adaptiveReason?: string;
  adaptiveLastAdjustmentAt?: string;
  adaptiveFrameBudgetMs?: number;
  adaptiveStabilityScore?: number;
  consecutiveCaptureFailures?: number;
  captureTimeouts?: number;
  staleCaptureDiscarded?: number;
  captureInFlight?: boolean;
  captureBackoffActive?: boolean;
  lastAmbientStopReason?: string;
  globalBleWriteInFlight?: number;
  globalBleWriteTimeoutCount?: number;
  globalBleWriteGateBusyCount?: number;
  adaptiveRecentBleFailureDelta?: number;
}
export type TransitionType = "smooth" | "instant";

export interface LampPreset {
  id: string;
  name: string;
  r: number;
  g: number;
  b: number;
  brightness: number;
  gradient?: {
    borderColor: string;
    mainColor: string;
    middleColor: string;
  };
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PresetSection {
  id: string;
  name: string;
  collapsed: boolean;
  presetIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LoopStep {
  id: string;
  name?: string;
  r: number;
  g: number;
  b: number;
  brightness: number;
  holdMs: number;
  transitionToNextMs: number;
  transitionType: TransitionType;
}

export interface LampLoop {
  id: string;
  name: string;
  steps: LoopStep[];
  notes?: string;
  sectionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoopSection {
  id: string;
  name: string;
  collapsed: boolean;
  loopIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  deviceName: string;
  deviceId?: string;
  autoConnect: boolean;
  liveUpdate: boolean;
  transitionEnabled: boolean;
  transitionDurationMs: number;
  activeWorkspace?: WorkspaceTab;
  ambient?: AmbientSettings;
  lastColor: {
    r: number;
    g: number;
    b: number;
    brightness: number;
  };
}

export interface AppState {
  schemaVersion?: number;
  settings: AppSettings;
  sections: PresetSection[];
  presets: LampPreset[];
  loopSections: LoopSection[];
  loops: LampLoop[];
  ambientConfigs?: AmbientConfig[];
  ambientConfigOrder?: string[];
}

export interface ExportBundle {
  schemaVersion: 2;
  exportedAt: string;
  app: "Sunlight";
  settings: AppSettings;
  sections: PresetSection[];
  presets: LampPreset[];
  loopSections: LoopSection[];
  loops: LampLoop[];
  ambientConfigs?: AmbientConfig[];
  ambientConfigOrder?: string[];
}
