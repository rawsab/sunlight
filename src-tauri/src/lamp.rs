use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use std::time::Duration;
use tokio::time::sleep;
use uuid::Uuid;

use crate::errors::LampError;
use crate::protocol::make_color_packet;

#[derive(Clone, serde::Serialize)]
pub struct NearbyLamp {
    pub id: String,
    pub name: String,
}

const SCAN_DURATION_SECS: u64 = 8;
static SCAN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Scan for the lamp and return the first matching peripheral.
async fn scan_peripherals() -> Result<Vec<Peripheral>, LampError> {
    let _scan_guard = SCAN_LOCK.lock().await;
    let manager = Manager::new()
        .await
        .map_err(|_| LampError::BluetoothUnavailable)?;

    let adapters = manager
        .adapters()
        .await
        .map_err(|_| LampError::BluetoothUnavailable)?;

    let adapter = adapters.into_iter().next().ok_or(LampError::BluetoothUnavailable)?;

    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|_| LampError::BluetoothUnavailable)?;

    sleep(Duration::from_secs(SCAN_DURATION_SECS)).await;

    adapter
        .stop_scan()
        .await
        .ok();

    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|_| LampError::BluetoothUnavailable)?;

    Ok(peripherals)
}

pub async fn discover_lamps() -> Result<Vec<NearbyLamp>, LampError> {
    let mut lamps = Vec::new();
    for p in scan_peripherals().await? {
        if let Ok(Some(props)) = p.properties().await {
            if let Some(name) = props.local_name.filter(|n| n.starts_with("SSL-")) {
                lamps.push(NearbyLamp { id: p.id().to_string(), name });
            }
        }
    }
    lamps.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(lamps)
}

pub async fn scan_for_lamp(target_id: Option<&str>, target_name: &str) -> Result<Peripheral, LampError> {
    for p in scan_peripherals().await? {
        if let Some(id) = target_id {
            if p.id().to_string() == id {
                return Ok(p);
            }
        } else if let Ok(Some(props)) = p.properties().await {
            if props.local_name.as_deref() == Some(target_name) {
                return Ok(p);
            }
        }
    }
    Err(LampError::DeviceNotFound)
}

/// Best-effort disconnect; ignores errors (device may already be gone or out of range).
pub async fn disconnect_peripheral(peripheral: &Peripheral) {
    if let Ok(true) = peripheral.is_connected().await {
        let _ = peripheral.disconnect().await;
    }
}

/// Connect and discover services/characteristics on the peripheral.
pub async fn connect_peripheral(peripheral: &Peripheral) -> Result<(), LampError> {
    peripheral
        .connect()
        .await
        .map_err(|_| LampError::DeviceUnavailable)?;

    peripheral
        .discover_services()
        .await
        .map_err(|_| LampError::DeviceUnavailable)?;

    Ok(())
}

/// Write an encrypted RGB + brightness command to the lamp.
pub async fn write_color(
    peripheral: &Peripheral,
    characteristic_uuid: Uuid,
    r: u8,
    g: u8,
    b: u8,
    brightness: u8,
) -> Result<(), LampError> {
    let chars = peripheral.characteristics();
    let characteristic = chars
        .iter()
        .find(|c| c.uuid == characteristic_uuid)
        .ok_or(LampError::WriteFailure)?;

    let packet = make_color_packet(r, g, b, brightness);

    peripheral
        .write(characteristic, &packet, WriteType::WithoutResponse)
        .await
        .map_err(|_| LampError::WriteFailure)?;

    Ok(())
}
