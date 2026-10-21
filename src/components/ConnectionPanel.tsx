import { useEffect, useRef, useState } from "react";
import { Wifi, WifiOff, Loader2, RotateCcw, Power, Radio } from "lucide-react";
import type { ConnectionStatus } from "../types";
import {
  connectLamp,
  disconnectLamp,
  getConnectionStatus,
  reconnectLamp,
} from "../lampApi";
import { formatConnectionError, refreshBluetooth } from "../connectionManager";

interface ConnectionPanelProps {
  status: ConnectionStatus;
  onStatusChange: (status: ConnectionStatus) => void;
  error: string | null;
  onError: (e: string | null) => void;
  hasSelectedLamp: boolean;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: "Disconnected",
  scanning: "Scanning…",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  stale: "Connection lost",
  failed: "Connection failed",
};

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  disconnected: "text-[#9090a0]",
  scanning: "text-[#facc15]",
  connecting: "text-[#facc15]",
  connected: "text-[#4ade80]",
  reconnecting: "text-[#fbbf24]",
  stale: "text-[#fbbf24]",
  failed: "text-[#f87171]",
};

const POLL_MS = 2000;

const innerGroupClass =
  "flex items-center gap-1.5 rounded-lg border border-[#2e2e38] bg-[#111114] px-2 py-1.5 min-w-0";

export function ConnectionPanel({
  status,
  onStatusChange,
  error,
  onError,
  hasSelectedLamp,
}: ConnectionPanelProps) {
  const [busy, setBusy] = useState(false);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    pollerRef.current = setInterval(async () => {
      try {
        const s = await getConnectionStatus();
        onStatusChange(s);
      } catch {
        // ignore poll errors
      }
    }, POLL_MS);
    return () => {
      if (pollerRef.current) clearInterval(pollerRef.current);
    };
  }, [onStatusChange]);

  const isBusyState =
    status === "scanning" || status === "connecting" || status === "reconnecting";
  const isConnected = status === "connected";
  const isAnimating = isBusyState;
  const isRecovering = status === "stale" || status === "reconnecting";
  const canConnect = status === "failed" || status === "disconnected" || status === "stale";

  const handleConnect = async () => {
    setBusy(true);
    onError(null);
    onStatusChange("scanning");
    try {
      await connectLamp();
      onStatusChange("connected");
    } catch (e: unknown) {
      onStatusChange("failed");
      onError(formatConnectionError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnectLamp();
      onStatusChange("disconnected");
      onError(null);
    } catch {
      onError("Failed to disconnect.");
    } finally {
      setBusy(false);
    }
  };

  const handleReconnect = async () => {
    setBusy(true);
    onError(null);
    onStatusChange("reconnecting");
    try {
      await reconnectLamp();
      onStatusChange("connected");
    } catch (e: unknown) {
      onStatusChange("failed");
      onError(formatConnectionError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    onError(null);
    try {
      await refreshBluetooth();
    } finally {
      setBusy(false);
    }
  };

  const statusIcon = isAnimating ? (
    <Loader2 size={14} className="text-[#facc15] animate-spin flex-shrink-0" />
  ) : isConnected ? (
    <Wifi size={14} className="text-[#4ade80] flex-shrink-0" />
  ) : isRecovering ? (
    <Loader2 size={14} className="text-[#fbbf24] animate-spin flex-shrink-0" />
  ) : (
    <WifiOff
      size={14}
      className={`flex-shrink-0 ${status === "failed" ? "text-[#f87171]" : "text-[#9090a0]"}`}
    />
  );

  return (
    <div className="rounded-xl border border-[#2e2e38] bg-[#18181c] p-3">
      <div className="flex flex-col gap-2">
        {/* Status + Refresh */}
        <div className={`${innerGroupClass} justify-between`}>
          <div className="flex items-center gap-2 min-w-0">
            {statusIcon}
            <span className={`text-xs font-semibold truncate ${STATUS_COLOR[status]}`}>
              {STATUS_LABEL[status]}
            </span>
          </div>
          <button
            onClick={handleRefresh}
            disabled={busy || isBusyState || !hasSelectedLamp}
            title="Refresh Bluetooth"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[#9090a0] hover:bg-[#2e2e38] disabled:opacity-50 transition-colors flex-shrink-0"
          >
            <Radio size={11} />
            Refresh
          </button>
        </div>

        {/* Reconnect + Disconnect, or Connect */}
        {(isConnected || canConnect) && (
          <div className={`${innerGroupClass} justify-end`}>
            {canConnect && (
              <button
                onClick={handleConnect}
                disabled={busy || isBusyState || !hasSelectedLamp}
                className="flex w-full items-center justify-center gap-1 rounded-md bg-[#ff8040]/15 px-2.5 py-1 text-xs font-medium text-[#ff8040] hover:bg-[#ff8040]/25 disabled:opacity-50 transition-colors"
              >
                <Power size={11} />
                Connect
              </button>
            )}

            {isConnected && (
              <>
                <button
                  onClick={handleReconnect}
                  disabled={busy || isBusyState}
                  title="Reconnect"
                  className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[#9090a0] hover:bg-[#2e2e38] disabled:opacity-50 transition-colors min-w-0"
                >
                  <RotateCcw size={11} className="flex-shrink-0" />
                  Reconnect
                </button>
                <button
                  onClick={handleDisconnect}
                  disabled={busy}
                  className="flex flex-1 items-center justify-center gap-1 rounded-md bg-red-500/15 px-2 py-1 text-xs font-medium text-[#f87171] hover:bg-red-500/25 disabled:opacity-50 transition-colors min-w-0"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {!hasSelectedLamp && (
        <p className="mt-3 text-[11px] leading-relaxed text-[#555568]">
          Select a lamp in Settings before connecting.
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-[#f87171] leading-relaxed">
          {error}
        </p>
      )}
    </div>
  );
}
