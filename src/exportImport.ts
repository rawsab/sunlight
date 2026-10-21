import { v4 as uuidv4 } from "uuid";
import type {
  AmbientConfig,
  AmbientSettings,
  AppState,
  ExportBundle,
  LampLoop,
  LampPreset,
  LoopSection,
  LoopStep,
  PresetSection,
  WorkspaceTab,
} from "./types";
import { DEFAULT_AMBIENT_SETTINGS } from "./types";
import { mergeAmbientSettings } from "./ambientDefaults";
import {
  dedupeAmbientConfigIds,
  migrateAmbientConfigs,
  parseAmbientConfig,
} from "./ambientConfigUtils";
import { seedDefaults } from "./presets";
import { seedLoopDefaults } from "./loops";

const APP_NAME = "Sunlight" as const;
const LEGACY_APP_NAME = "Sunset Lamp Controller" as const;
export const EXPORT_SCHEMA_VERSION = 2;

export function buildExportBundle(state: AppState): ExportBundle {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: APP_NAME,
    settings: state.settings,
    sections: state.sections,
    presets: state.presets,
    loopSections: state.loopSections,
    loops: state.loops,
    ambientConfigs: state.ambientConfigs ?? [],
    ambientConfigOrder: state.ambientConfigOrder ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampByte(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n < 0 || n > max) return null;
  return n;
}

function parsePreset(raw: unknown): LampPreset | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;

  const r = clampByte(raw.r, 255);
  const g = clampByte(raw.g, 255);
  const b = clampByte(raw.b, 255);
  const brightness = clampByte(raw.brightness, 64);
  if (r === null || g === null || b === null || brightness === null) return null;

  const now = new Date().toISOString();
  let gradient: LampPreset["gradient"];
  if (isRecord(raw.gradient)) {
    const borderColor = raw.gradient.borderColor;
    const mainColor = raw.gradient.mainColor;
    const middleColor = raw.gradient.middleColor;
    if (
      typeof borderColor === "string" &&
      typeof mainColor === "string" &&
      typeof middleColor === "string"
    ) {
      gradient = { borderColor, mainColor, middleColor };
    }
  }

  return {
    id: raw.id,
    name: raw.name.trim() || "Untitled",
    r,
    g,
    b,
    brightness,
    gradient,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function parseSection(raw: unknown): PresetSection | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;

  const now = new Date().toISOString();
  const presetIds = Array.isArray(raw.presetIds)
    ? raw.presetIds.filter((id): id is string => typeof id === "string")
    : [];

  return {
    id: raw.id,
    name: raw.name.trim() || "Untitled Section",
    collapsed: typeof raw.collapsed === "boolean" ? raw.collapsed : false,
    presetIds,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function parseLoopStep(raw: unknown): LoopStep | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const r = clampByte(raw.r, 255);
  const g = clampByte(raw.g, 255);
  const b = clampByte(raw.b, 255);
  const brightness = clampByte(raw.brightness, 64);
  if (r === null || g === null || b === null || brightness === null) return null;

  const holdMs =
    typeof raw.holdMs === "number" && raw.holdMs >= 0 ? Math.round(raw.holdMs) : null;
  const transitionToNextMs =
    typeof raw.transitionToNextMs === "number" && raw.transitionToNextMs >= 0
      ? Math.round(raw.transitionToNextMs)
      : null;
  if (holdMs === null || transitionToNextMs === null) return null;

  const transitionType = raw.transitionType === "instant" ? "instant" : "smooth";

  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : undefined,
    r,
    g,
    b,
    brightness,
    holdMs,
    transitionToNextMs,
    transitionType,
  };
}

function parseLoop(raw: unknown): LampLoop | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  if (typeof raw.sectionId !== "string" || !Array.isArray(raw.steps)) return null;

  const steps = raw.steps.map(parseLoopStep).filter((s): s is LoopStep => s !== null);
  if (steps.length < 2) return null;

  const now = new Date().toISOString();
  return {
    id: raw.id,
    name: raw.name.trim() || "Untitled Loop",
    steps,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    sectionId: raw.sectionId,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function parseLoopSection(raw: unknown): LoopSection | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;

  const now = new Date().toISOString();
  const loopIds = Array.isArray(raw.loopIds)
    ? raw.loopIds.filter((id): id is string => typeof id === "string")
    : [];

  return {
    id: raw.id,
    name: raw.name.trim() || "Untitled Section",
    collapsed: typeof raw.collapsed === "boolean" ? raw.collapsed : false,
    loopIds,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function parseAmbientSettings(raw: unknown): AmbientSettings {
  if (!isRecord(raw)) return DEFAULT_AMBIENT_SETTINGS;
  return mergeAmbientSettings(raw as Partial<AmbientSettings>);
}

function parseSettings(raw: unknown): AppState["settings"] | null {
  if (!isRecord(raw)) return null;

  const lastColorRaw = raw.lastColor;
  if (!isRecord(lastColorRaw)) return null;

  const r = clampByte(lastColorRaw.r, 255);
  const g = clampByte(lastColorRaw.g, 255);
  const b = clampByte(lastColorRaw.b, 255);
  const brightness = clampByte(lastColorRaw.brightness, 64);
  if (r === null || g === null || b === null || brightness === null) return null;

  const transitionDurationMs =
    typeof raw.transitionDurationMs === "number" && raw.transitionDurationMs >= 100
      ? Math.min(Math.round(raw.transitionDurationMs), 3000)
      : 1200;

  const activeWorkspace: WorkspaceTab =
    raw.activeWorkspace === "loops"
      ? "loops"
      : raw.activeWorkspace === "ambient"
        ? "ambient"
        : "presets";

  return {
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : undefined,
    deviceName: typeof raw.deviceName === "string" ? raw.deviceName : "SSL-99A4C3",
    autoConnect: typeof raw.autoConnect === "boolean" ? raw.autoConnect : false,
    liveUpdate: typeof raw.liveUpdate === "boolean" ? raw.liveUpdate : true,
    transitionEnabled:
      typeof raw.transitionEnabled === "boolean" ? raw.transitionEnabled : true,
    transitionDurationMs,
    activeWorkspace,
    ambient: parseAmbientSettings(raw.ambient),
    lastColor: { r, g, b, brightness },
  };
}

function dedupePresetIds(presets: LampPreset[], sections: PresetSection[]) {
  const seenPresetIds = new Set<string>();
  const idMap = new Map<string, string>();

  const newPresets = presets.map((preset) => {
    if (!seenPresetIds.has(preset.id)) {
      seenPresetIds.add(preset.id);
      return preset;
    }
    const newId = uuidv4();
    idMap.set(preset.id, newId);
    return { ...preset, id: newId };
  });

  const seenSectionIds = new Set<string>();
  const newSections = sections.map((section) => {
    let sectionId = section.id;
    if (seenSectionIds.has(sectionId)) sectionId = uuidv4();
    seenSectionIds.add(sectionId);

    const presetIds = section.presetIds
      .map((id) => idMap.get(id) ?? id)
      .filter((id) => newPresets.some((p) => p.id === id));

    return { ...section, id: sectionId, presetIds };
  });

  const assigned = new Set(newSections.flatMap((s) => s.presetIds));
  const orphans = newPresets.filter((p) => !assigned.has(p.id));

  if (orphans.length > 0) {
    if (newSections.length === 0) {
      const now = new Date().toISOString();
      newSections.push({
        id: uuidv4(),
        name: "Imported",
        collapsed: false,
        presetIds: orphans.map((p) => p.id),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      newSections[0] = {
        ...newSections[0],
        presetIds: [...newSections[0].presetIds, ...orphans.map((p) => p.id)],
      };
    }
  }

  return { presets: newPresets, sections: newSections };
}

function dedupeLoopIds(loops: LampLoop[], loopSections: LoopSection[]) {
  const seenLoopIds = new Set<string>();
  const idMap = new Map<string, string>();

  const newLoops = loops.map((loop) => {
    if (!seenLoopIds.has(loop.id)) {
      seenLoopIds.add(loop.id);
      return loop;
    }
    const newId = uuidv4();
    idMap.set(loop.id, newId);
    return { ...loop, id: newId };
  });

  const seenSectionIds = new Set<string>();
  const newSections = loopSections.map((section) => {
    let sectionId = section.id;
    if (seenSectionIds.has(sectionId)) sectionId = uuidv4();
    seenSectionIds.add(sectionId);

    const loopIds = section.loopIds
      .map((id) => idMap.get(id) ?? id)
      .filter((id) => newLoops.some((l) => l.id === id));

    return { ...section, id: sectionId, loopIds };
  });

  const assigned = new Set(newSections.flatMap((s) => s.loopIds));
  const orphans = newLoops.filter((l) => !assigned.has(l.id));

  if (orphans.length > 0) {
    if (newSections.length === 0) {
      const now = new Date().toISOString();
      newSections.push({
        id: uuidv4(),
        name: "Imported",
        collapsed: false,
        loopIds: orphans.map((l) => l.id),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      newSections[0] = {
        ...newSections[0],
        loopIds: [...newSections[0].loopIds, ...orphans.map((l) => l.id)],
      };
    }
  }

  newLoops.forEach((loop) => {
    if (!newSections.some((s) => s.loopIds.includes(loop.id))) {
      if (newSections.length > 0) {
        newSections[0] = {
          ...newSections[0],
          loopIds: [...newSections[0].loopIds, loop.id],
        };
      }
      loop.sectionId = newSections[0]?.id ?? loop.sectionId;
    } else {
      const sec = newSections.find((s) => s.loopIds.includes(loop.id));
      if (sec) loop.sectionId = sec.id;
    }
  });

  return { loops: newLoops, loopSections: newSections };
}

export function validateImportBundle(
  raw: unknown
): { ok: true; data: AppState } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: "Invalid file: expected a JSON object." };
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    return { ok: false, error: "Unsupported backup version. Expected schemaVersion 1 or 2." };
  }

  if (raw.app !== APP_NAME && raw.app !== LEGACY_APP_NAME) {
    return { ok: false, error: "This file does not appear to be a Sunlight backup." };
  }

  const settings = parseSettings(raw.settings);
  if (!settings) {
    return { ok: false, error: "Invalid or missing settings in backup file." };
  }

  if (!Array.isArray(raw.presets) || !Array.isArray(raw.sections)) {
    return { ok: false, error: "Backup file must include presets and sections arrays." };
  }

  const presets = raw.presets.map(parsePreset).filter((p): p is LampPreset => p !== null);
  const sections = raw.sections.map(parseSection).filter((s): s is PresetSection => s !== null);

  const rawLoops = schemaVersion === 2 && Array.isArray(raw.loops) ? raw.loops : [];
  const rawLoopSections =
    schemaVersion === 2 && Array.isArray(raw.loopSections) ? raw.loopSections : [];

  const loops = rawLoops.map(parseLoop).filter((l): l is LampLoop => l !== null);
  const loopSections = rawLoopSections
    .map(parseLoopSection)
    .filter((s): s is LoopSection => s !== null);

  if (presets.length === 0 && sections.length === 0 && loops.length === 0) {
    return { ok: false, error: "Backup file contains no valid presets or loops." };
  }

  const normalizedPresets = dedupePresetIds(presets, sections);
  const { loops: defaultLoops, loopSections: defaultLoopSections } = seedLoopDefaults();

  const normalizedLoops =
    loops.length > 0 || loopSections.length > 0
      ? dedupeLoopIds(loops, loopSections)
      : { loops: defaultLoops, loopSections: defaultLoopSections };

  const rawAmbientConfigs =
    schemaVersion === 2 && Array.isArray(raw.ambientConfigs) ? raw.ambientConfigs : [];
  const rawAmbientConfigOrder =
    schemaVersion === 2 && Array.isArray(raw.ambientConfigOrder)
      ? raw.ambientConfigOrder
      : [];
  const parsedConfigs = rawAmbientConfigs
    .map(parseAmbientConfig)
    .filter((c): c is AmbientConfig => c !== null);
  const dedupedConfigs = dedupeAmbientConfigIds(parsedConfigs);
  const { configs: ambientConfigs, order: ambientConfigOrder } = migrateAmbientConfigs(
    dedupedConfigs,
    rawAmbientConfigOrder
  );

  return {
    ok: true,
    data: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      settings,
      presets: normalizedPresets.presets,
      sections:
        normalizedPresets.sections.length > 0
          ? normalizedPresets.sections
          : seedDefaults().sections,
      loops: normalizedLoops.loops,
      loopSections:
        normalizedLoops.loopSections.length > 0
          ? normalizedLoops.loopSections
          : defaultLoopSections,
      ambientConfigs,
      ambientConfigOrder,
    },
  };
}

export function parseImportJson(
  text: string
): { ok: true; data: AppState } | { ok: false; error: string } {
  try {
    const raw = JSON.parse(text) as unknown;
    return validateImportBundle(raw);
  } catch {
    return { ok: false, error: "Could not parse JSON. The file may be corrupted." };
  }
}

export function getDefaultExportFilename(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `sunlight-backup-${date}.json`;
}

export function ensureJsonExtension(path: string): string {
  return path.toLowerCase().endsWith(".json") ? path : `${path}.json`;
}
