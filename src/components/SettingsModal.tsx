import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatConnectionError } from "../connectionManager";
import { X, Download, Upload, RotateCcw, ChevronDown, Radio, Loader2 } from "lucide-react";
import { Modal } from "./Modal";

interface SettingsModalProps {
  open: boolean;
  deviceName: string;
  deviceId?: string;
  connectionBusy: boolean;
  onLampChange: (id: string, name: string) => void;
  autoConnect: boolean;
  onAutoConnectChange: (v: boolean) => void;
  transitionEnabled: boolean;
  onTransitionEnabledChange: (v: boolean) => void;
  transitionDurationMs: number;
  onTransitionDurationChange: (ms: number) => void;
  onExport: () => void;
  onImport: () => void;
  onResetPresets: () => void;
  onClose: () => void;
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-[#f0f0f4]">{label}</p>
        {description && (
          <p className="mt-0.5 text-xs text-[#555568] leading-relaxed">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out ${
          checked ? "bg-[#ff8040]/80" : "bg-[#2e2e38]"
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 left-0.5 block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-in-out ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsModal({
  open,
  deviceName, deviceId, connectionBusy, onLampChange,
  autoConnect,
  onAutoConnectChange,
  transitionEnabled,
  onTransitionEnabledChange,
  transitionDurationMs,
  onTransitionDurationChange,
  onExport,
  onImport,
  onResetPresets,
  onClose,
}: SettingsModalProps) {
  const [lamps, setLamps] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scan = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const found = await invoke<{ id: string; name: string }[]>("discover_lamps");
      setLamps(found);
      if (!found.length) setMessage("No nearby lamps found. Turn on your lamp, close iStrip, and scan again.");
    } catch (e) { setError(formatConnectionError(e)); }
    finally { setBusy(false); }
  };
  const select = async (id: string) => {
    const lamp = lamps.find(l => l.id === id);
    if (!lamp) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await invoke("select_lamp", { id, name: lamp.name });
      onLampChange(id, lamp.name);
      setMessage("Lamp selected. Use Connect to connect to this lamp.");
    } catch (e) { setError(formatConnectionError(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} panelClassName="w-[400px] rounded-xl border border-[#2e2e38] bg-[#1e1e24] shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2e2e38]">
          <h2 className="text-sm font-semibold text-[#f0f0f4]">Settings</h2>
          <button
            onClick={onClose}
            className="text-[#555568] hover:text-[#9090a0] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto">
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-[#f0f0f4]">Sunlight lamp</h3>
            <p className="text-xs text-[#555568] leading-relaxed">Choose a lamp to connect to. Switching disconnects the current lamp.</p>
            <label htmlFor="lamp-choice" className="block text-xs font-medium text-[#9090a0]">Selected lamp</label>
            <div className="relative">
            <select id="lamp-choice" value={deviceId ?? ""} disabled={busy || connectionBusy}
              onChange={e => void select(e.target.value)}
              className="w-full appearance-none rounded-lg border border-[#2e2e38] bg-[#111114] py-2 pl-3 pr-8 font-[inherit] text-xs font-medium text-[#f0f0f4] outline-none transition-colors hover:border-[#555568] focus-visible:border-[#ff8040]/60 focus-visible:ring-2 focus-visible:ring-[#ff8040]/15 disabled:opacity-50">
              {!lamps.some(l => l.id === deviceId) && <option value={deviceId ?? ""}>{deviceName}{deviceId ? ` · ${deviceId}` : " (saved lamp)"}</option>}
              {lamps.map(l => <option key={l.id} value={l.id}>{l.name} · {l.id}</option>)}
            </select>
            <ChevronDown size={13} aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#555568]" />
            </div>
            <button onClick={() => void scan()} disabled={busy || connectionBusy}
              className="flex w-full items-center gap-2 rounded-lg border border-[#2e2e38] bg-[#111114] px-3 py-2 text-xs font-medium text-[#9090a0] outline-none transition-colors hover:bg-[#1e1e24] hover:text-[#f0f0f4] focus-visible:border-[#ff8040]/60 focus-visible:ring-2 focus-visible:ring-[#ff8040]/15 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Radio size={13} />}
              {busy ? "Please wait…" : "Scan for nearby lamps"}
            </button>
            {message && <p role="status" className="text-xs text-[#9090a0]">{message}</p>}
            {error && <p role="alert" className="text-xs text-[#f87171]">{error}</p>}
          </div>
          <div className="border-t border-[#2e2e38]" />
          <Toggle
            checked={autoConnect}
            onChange={onAutoConnectChange}
            label="Auto-connect on launch"
            description="Automatically connect to the lamp when the app opens."
          />

          <div className="border-t border-[#2e2e38]" />

          <Toggle
            checked={transitionEnabled}
            onChange={onTransitionEnabledChange}
            label="Smooth transitions"
            description="Fade between colors when selecting a preset."
          />

          {transitionEnabled && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-[#9090a0]">
                  Transition duration
                </label>
                <span className="text-xs font-mono text-[#555568]">
                  {transitionDurationMs} ms
                </span>
              </div>
              <input
                type="range"
                min={100}
                max={3000}
                step={100}
                value={transitionDurationMs}
                onChange={(e) => onTransitionDurationChange(parseInt(e.target.value))}
                className="w-full"
                style={{
                  background: `linear-gradient(90deg, #ff8040 ${((transitionDurationMs - 100) / 2900) * 100}%, #2e2e38 ${((transitionDurationMs - 100) / 2900) * 100}%)`,
                }}
              />
              <div className="flex justify-between mt-1">
                <span className="text-[10px] text-[#555568]">100 ms</span>
                <span className="text-[10px] text-[#555568]">3000 ms</span>
              </div>
            </div>
          )}

          <div className="border-t border-[#2e2e38]" />

          <div>
            <h3 className="text-sm font-medium text-[#f0f0f4] mb-1">Data & Backup</h3>
            <p className="text-xs text-[#555568] leading-relaxed mb-3">
              Export or import your presets, sections, and settings as JSON.
            </p>
            <div className="space-y-2">
              <button
                onClick={onExport}
                className="flex w-full items-center gap-2 rounded-lg border border-[#2e2e38] bg-[#111114] px-3 py-2 text-xs font-medium text-[#9090a0] hover:bg-[#1e1e24] hover:text-[#f0f0f4] transition-colors"
              >
                <Download size={13} />
                Export configuration
              </button>
              <button
                onClick={onImport}
                className="flex w-full items-center gap-2 rounded-lg border border-[#2e2e38] bg-[#111114] px-3 py-2 text-xs font-medium text-[#9090a0] hover:bg-[#1e1e24] hover:text-[#f0f0f4] transition-colors"
              >
                <Upload size={13} />
                Import configuration
              </button>
              <button
                onClick={onResetPresets}
                className="flex w-full items-center gap-2 rounded-lg border border-[#2e2e38] bg-[#111114] px-3 py-2 text-xs font-medium text-[#f87171] hover:bg-red-500/10 transition-colors"
              >
                <RotateCcw size={13} />
                Reset to defaults
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end px-5 py-4 border-t border-[#2e2e38]">
          <button
            onClick={onClose}
            className="rounded-lg bg-[#ff8040]/20 px-4 py-2 text-xs font-semibold text-[#ff8040] hover:bg-[#ff8040]/30 transition-colors"
          >
            Done
          </button>
        </div>
    </Modal>
  );
}
