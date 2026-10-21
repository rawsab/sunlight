import type { AppState } from "./types";
import { DEFAULT_AMBIENT_SETTINGS } from "./types";
import { mergeAmbientSettings } from "./ambientDefaults";
import { migrateAmbientConfigs, seedAmbientDefaults } from "./ambientConfigUtils";
import { seedDefaults } from "./presets";
import { seedLoopDefaults, ensureDefaultLoopSections } from "./loops";

export const CURRENT_SCHEMA_VERSION = 2;

/** Previous builds stored this as the lamp name before a lamp was chosen. */
const LEGACY_PLACEHOLDER_DEVICE_NAME = "SSL-99A4C3";

export function normalizeDeviceSelection(
  deviceName: unknown,
  deviceId: unknown
): { deviceName: string; deviceId?: string } {
  const name = typeof deviceName === "string" ? deviceName.trim() : "";
  const id = typeof deviceId === "string" && deviceId.trim() ? deviceId.trim() : undefined;
  if (!id && (name === "" || name === LEGACY_PLACEHOLDER_DEVICE_NAME)) {
    return { deviceName: "" };
  }
  return { deviceName: name, deviceId: id };
}

export function migrateAppState(raw: Partial<AppState> | null): AppState | null {
  if (!raw || !raw.settings) return null;

  const needsLoopMigration = raw.loops === undefined && raw.loopSections === undefined;
  const { loops: defaultLoops, loopSections: defaultLoopSections } = seedLoopDefaults();

  const { configs: ambientConfigs, order: ambientConfigOrder } = migrateAmbientConfigs(
    raw.ambientConfigs,
    raw.ambientConfigOrder
  );

  const device = normalizeDeviceSelection(raw.settings.deviceName, raw.settings.deviceId);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    settings: {
      deviceName: device.deviceName,
      deviceId: device.deviceId,
      autoConnect: raw.settings.autoConnect ?? false,
      liveUpdate: raw.settings.liveUpdate ?? true,
      transitionEnabled: raw.settings.transitionEnabled ?? true,
      transitionDurationMs: raw.settings.transitionDurationMs ?? 1200,
      activeWorkspace: "presets",
      ambient: mergeAmbientSettings(raw.settings.ambient),
      lastColor: raw.settings.lastColor ?? { r: 255, g: 128, b: 0, brightness: 64 },
    },
    sections: raw.sections ?? [],
    presets: raw.presets ?? [],
    loops: needsLoopMigration ? defaultLoops : (raw.loops ?? []),
    loopSections: needsLoopMigration
      ? defaultLoopSections
      : ensureDefaultLoopSections(raw.loopSections ?? []),
    ambientConfigs,
    ambientConfigOrder,
  };
}

export function createFreshAppState(): AppState {
  const { presets, sections } = seedDefaults();
  const { loops, loopSections } = seedLoopDefaults();
  const { configs: ambientConfigs, order: ambientConfigOrder } = seedAmbientDefaults();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    settings: {
      deviceName: "",
      autoConnect: false,
      liveUpdate: true,
      transitionEnabled: true,
      transitionDurationMs: 1200,
      activeWorkspace: "presets",
      ambient: DEFAULT_AMBIENT_SETTINGS,
      lastColor: { r: 255, g: 128, b: 0, brightness: 64 },
    },
    sections,
    presets,
    loops,
    loopSections,
    ambientConfigs,
    ambientConfigOrder,
  };
}
