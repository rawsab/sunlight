import { useState } from "react";
import { SlidersHorizontal, Circle, Send, Power } from "lucide-react";
import { RgbSliders } from "./RgbSliders";
import { ColorWheelPicker } from "./ColorWheelPicker";
import { CurrentColorPreview } from "./CurrentColorPreview";
import type { ConnectionStatus } from "../types";
import { throttledSetColor } from "../lampApi";
import { safeSetColor } from "../connectionManager";

type PickerMode = "sliders" | "wheel";

interface ColorControlPanelProps {
  powerBusy: boolean;
  onPowerChange: (on: boolean) => Promise<void>;
  r: number;
  g: number;
  b: number;
  brightness: number;
  status: ConnectionStatus;
  liveUpdate: boolean;
  onLiveUpdateChange: (v: boolean) => void;
  onColorChange: (r: number, g: number, b: number, brightness: number) => void;
  onSaveAsPreset: () => void;
}

export function ColorControlPanel({
  powerBusy,
  onPowerChange,
  r,
  g,
  b,
  brightness,
  status,
  liveUpdate,
  onLiveUpdateChange,
  onColorChange,
  onSaveAsPreset,
}: ColorControlPanelProps) {
  const [mode, setMode] = useState<PickerMode>("sliders");
  const connected = status === "connected";

  const handleChange = (nr: number, ng: number, nb: number, nbr: number) => {
    onColorChange(nr, ng, nb, nbr);
    if (connected && liveUpdate) {
      throttledSetColor(nr, ng, nb, nbr);
    }
  };

  const handleWheelChange = (nr: number, ng: number, nb: number) => {
    handleChange(nr, ng, nb, brightness);
  };

  const handleApply = async () => {
    await safeSetColor(r, g, b, brightness);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 rounded-xl border border-[#2e2e38] bg-[#18181c] p-3" aria-label="Lamp power">
        <button type="button" disabled={!connected || powerBusy}
          onClick={() => void onPowerChange(true)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#ff8040]/15 px-3 py-2 text-xs font-medium text-[#ff8040] transition-colors hover:bg-[#ff8040]/25 disabled:opacity-50">
          <Power size={13} /> Turn on
        </button>
        <button type="button" disabled={!connected || powerBusy}
          onClick={() => void onPowerChange(false)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#2e2e38] bg-[#111114] px-3 py-2 text-xs font-medium text-[#9090a0] transition-colors hover:bg-[#2e2e38] hover:text-[#f0f0f4] disabled:opacity-50">
          <Power size={13} /> Turn off
        </button>
      </div>
      <CurrentColorPreview r={r} g={g} b={b} brightness={brightness} connected={connected} />

      <div className="rounded-xl border border-[#2e2e38] bg-[#18181c] p-4">
        <div className="mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-[#2e2e38] p-1">
            <button
              onClick={() => setMode("sliders")}
              className={`flex items-center justify-center gap-2 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mode === "sliders"
                  ? "bg-[#2e2e38] text-[#f0f0f4]"
                  : "text-[#555568] hover:text-[#9090a0]"
              }`}
            >
              <SlidersHorizontal size={11} />
              Sliders
            </button>
            <button
              onClick={() => setMode("wheel")}
              className={`flex items-center justify-center gap-2 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mode === "wheel"
                  ? "bg-[#2e2e38] text-[#f0f0f4]"
                  : "text-[#555568] hover:text-[#9090a0]"
              }`}
            >
              <Circle size={11} />
              Wheel
            </button>
          </div>

          <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
            <span className="text-[11px] text-[#9090a0]">Live updates</span>
            <button
              type="button"
              role="switch"
              aria-label="Live updates"
              aria-checked={liveUpdate}
              onClick={() => onLiveUpdateChange(!liveUpdate)}
              className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out ${
                liveUpdate ? "bg-[#ff8040]/80" : "bg-[#2e2e38]"
              }`}
            >
              <span
                aria-hidden="true"
                className={`absolute top-0.5 left-0.5 block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-in-out ${
                  liveUpdate ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>
        </div>

        {mode === "sliders" ? (
          <RgbSliders r={r} g={g} b={b} brightness={brightness} onChange={handleChange} />
        ) : (
          <div className="space-y-3">
            <ColorWheelPicker r={r} g={g} b={b} onChange={handleWheelChange} />
            <div className="border-t border-[#1e1e24] pt-3">
              <RgbSliders
                r={r}
                g={g}
                b={b}
                brightness={brightness}
                onChange={handleChange}
              />
            </div>
          </div>
        )}

        {!liveUpdate && connected && (
          <button
            onClick={handleApply}
            className="mt-3 w-full flex items-center justify-center gap-1.5 rounded-lg bg-[#ff8040]/15 py-2 text-xs font-semibold text-[#ff8040] hover:bg-[#ff8040]/25 transition-colors"
          >
            <Send size={11} />
            Apply to Lamp
          </button>
        )}
      </div>

      <button
        onClick={onSaveAsPreset}
        className="w-full rounded-xl border border-[#2e2e38] bg-[#18181c] py-2 text-xs font-medium text-[#9090a0] hover:bg-[#1e1e24] hover:text-[#f0f0f4] transition-colors"
      >
        + Save Current as Preset
      </button>
    </div>
  );
}
