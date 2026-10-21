use crate::ble_write::{write_color_if_connected, WritePriority};
use crate::connection_events::emit_connection_status;
use crate::errors::LampError;
use crate::lamp::{connect_peripheral, disconnect_peripheral, scan_for_lamp};
use crate::state::{ConnectMode, ConnectionStatus, SharedLampState};

use std::time::{Duration, Instant};
use tauri::async_runtime;
use tokio::time::sleep;

const INITIAL_RECONNECT_DELAY_MS: u64 = 1000;
const MAX_RECONNECT_DELAY_MS: u64 = 30_000;
const TEARDOWN_DELAY_MS: u64 = 400;
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(15);
const KEEPALIVE_IDLE: Duration = Duration::from_secs(20);

fn reconnect_delay(attempt: u32) -> u64 {
    let delay = INITIAL_RECONNECT_DELAY_MS.saturating_mul(2u64.saturating_pow(attempt.min(5)));
    delay.min(MAX_RECONNECT_DELAY_MS)
}

pub async fn mark_stale(state: &SharedLampState) {
    let peripheral = {
        let mut s = state.lock().await;
        if s.status == ConnectionStatus::Disconnected || s.user_disconnected {
            return;
        }
        s.status = ConnectionStatus::Stale;
        s.peripheral.take()
    };

    emit_connection_status(&ConnectionStatus::Stale);

    if let Some(p) = peripheral {
        disconnect_peripheral(&p).await;
    }
}

pub fn spawn_auto_reconnect(state: SharedLampState) {
    async_runtime::spawn(async move {
        attempt_auto_reconnect(state).await;
    });
}

pub fn spawn_connection_watchdog(state: SharedLampState) {
    async_runtime::spawn(async move {
        connection_watchdog(state).await;
    });
}

async fn connection_watchdog(state: SharedLampState) {
    loop {
        sleep(WATCHDOG_INTERVAL).await;

        maybe_send_keepalive(&state).await;

        let should_reconnect = {
            let s = state.lock().await;
            !s.user_disconnected
                && !s.reconnect_in_progress
                && matches!(
                    s.status,
                    ConnectionStatus::Stale | ConnectionStatus::Failed
                )
        };

        if should_reconnect {
            spawn_auto_reconnect(state.clone());
        }
    }
}

async fn maybe_send_keepalive(state: &SharedLampState) {
    let color = {
        let s = state.lock().await;
        if s.user_disconnected || s.status != ConnectionStatus::Connected {
            return;
        }
        if s.reconnect_in_progress {
            return;
        }
        let idle = match s.last_write_at {
            Some(t) => t.elapsed() >= KEEPALIVE_IDLE,
            None => true,
        };
        if !idle {
            return;
        }
        s.last_color
    };

    let Some((r, g, b, brightness)) = color else {
        return;
    };

    let _ = write_color_if_connected(
        state,
        r,
        g,
        b,
        brightness,
        WritePriority::Watchdog,
    )
    .await;
}

async fn attempt_auto_reconnect(state: SharedLampState) {
    let epoch_at_start = {
        let mut s = state.lock().await;
        if s.user_disconnected {
            return;
        }
        if s.reconnect_in_progress {
            return;
        }
        s.reconnect_in_progress = true;
        s.status = ConnectionStatus::Reconnecting;
        s.connect_epoch
    };

    emit_connection_status(&ConnectionStatus::Reconnecting);

    let mut attempt: u32 = 0;

    loop {
        {
            let mut s = state.lock().await;
            if s.user_disconnected {
                s.reconnect_in_progress = false;
                return;
            }
            if s.connect_epoch != epoch_at_start {
                s.reconnect_in_progress = false;
                return;
            }
            if s.status == ConnectionStatus::Connected {
                s.reconnect_in_progress = false;
                s.reconnect_attempts = 0;
                s.last_reconnect_at = None;
                return;
            }
        }

        let delay = reconnect_delay(attempt);
        sleep(Duration::from_millis(delay)).await;
        attempt += 1;

        {
            let mut s = state.lock().await;
            if s.user_disconnected || s.connect_epoch != epoch_at_start {
                s.reconnect_in_progress = false;
                return;
            }
            if s.status == ConnectionStatus::Connected {
                s.reconnect_in_progress = false;
                s.reconnect_attempts = 0;
                s.last_reconnect_at = None;
                return;
            }
        }

        let existing = {
            let mut s = state.lock().await;
            s.status = ConnectionStatus::Reconnecting;
            emit_connection_status(&ConnectionStatus::Reconnecting);
            s.peripheral.take()
        };

        if let Some(p) = existing {
            disconnect_peripheral(&p).await;
            sleep(Duration::from_millis(TEARDOWN_DELAY_MS)).await;
        }

        {
            let mut s = state.lock().await;
            if s.user_disconnected || s.connect_epoch != epoch_at_start {
                s.reconnect_in_progress = false;
                return;
            }
        }

        let target = {
            let s = state.lock().await;
            (s.target_id.clone(), s.target_name.clone())
        };
        let peripheral = match scan_for_lamp(target.0.as_deref(), &target.1).await {
            Ok(p) => p,
            Err(_) => {
                let mut s = state.lock().await;
                if s.user_disconnected || s.connect_epoch != epoch_at_start {
                    return;
                }
                s.reconnect_attempts = s.reconnect_attempts.saturating_add(1);
                s.status = ConnectionStatus::Failed;
                s.last_reconnect_at = Some(Instant::now());
                emit_connection_status(&ConnectionStatus::Failed);
                continue;
            }
        };

        {
            let mut s = state.lock().await;
            if s.user_disconnected || s.connect_epoch != epoch_at_start {
                s.reconnect_in_progress = false;
                return;
            }
            s.status = ConnectionStatus::Connecting;
            emit_connection_status(&ConnectionStatus::Connecting);
        }

        if connect_peripheral(&peripheral).await.is_err() {
            let mut s = state.lock().await;
            if s.user_disconnected || s.connect_epoch != epoch_at_start {
                disconnect_peripheral(&peripheral).await;
                return;
            }
            s.reconnect_attempts = s.reconnect_attempts.saturating_add(1);
            s.status = ConnectionStatus::Failed;
            s.last_reconnect_at = Some(Instant::now());
            emit_connection_status(&ConnectionStatus::Failed);
            continue;
        }

        let mut s = state.lock().await;
        if s.user_disconnected || s.connect_epoch != epoch_at_start {
            s.reconnect_in_progress = false;
            disconnect_peripheral(&peripheral).await;
            return;
        }
        s.status = ConnectionStatus::Connected;
        s.peripheral = Some(peripheral);
        s.reconnect_in_progress = false;
        s.reconnect_attempts = 0;
        s.last_reconnect_at = None;
        emit_connection_status(&ConnectionStatus::Connected);
        return;
    }
}

/// Used by lib.rs perform_connect — exposed for manual connect paths.
pub async fn perform_connect(
    state: &SharedLampState,
    mode: ConnectMode,
) -> Result<(), LampError> {
    let initial_status = match mode {
        ConnectMode::Reconnect => ConnectionStatus::Reconnecting,
        ConnectMode::Manual | ConnectMode::Refresh => ConnectionStatus::Scanning,
    };

    let existing = {
        let mut s = state.lock().await;
        s.connect_epoch = s.connect_epoch.wrapping_add(1);
        s.reconnect_in_progress = true;
        s.status = initial_status.clone();
        s.peripheral.take()
    };

    emit_connection_status(&initial_status);

    if let Some(p) = existing {
        disconnect_peripheral(&p).await;
        sleep(Duration::from_millis(TEARDOWN_DELAY_MS)).await;
    }

    let target = {
            let s = state.lock().await;
            (s.target_id.clone(), s.target_name.clone())
        };
        let peripheral = match scan_for_lamp(target.0.as_deref(), &target.1).await {
        Ok(p) => p,
        Err(e) => {
            let mut s = state.lock().await;
            s.reconnect_in_progress = false;
            s.status = ConnectionStatus::Failed;
            s.last_reconnect_at = Some(Instant::now());
            emit_connection_status(&ConnectionStatus::Failed);
            return Err(e);
        }
    };

    {
        let mut s = state.lock().await;
        s.status = ConnectionStatus::Connecting;
    }
    emit_connection_status(&ConnectionStatus::Connecting);

    if let Err(e) = connect_peripheral(&peripheral).await {
        let mut s = state.lock().await;
        s.reconnect_in_progress = false;
        s.status = ConnectionStatus::Failed;
        s.last_reconnect_at = Some(Instant::now());
        emit_connection_status(&ConnectionStatus::Failed);
        return Err(e);
    }

    let mut s = state.lock().await;
    s.status = ConnectionStatus::Connected;
    s.peripheral = Some(peripheral);
    s.reconnect_in_progress = false;
    s.reconnect_attempts = 0;
    s.user_disconnected = false;
    s.last_reconnect_at = None;
    emit_connection_status(&ConnectionStatus::Connected);
    Ok(())
}
