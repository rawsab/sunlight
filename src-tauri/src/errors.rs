use thiserror::Error;

#[derive(Debug, Error)]
pub enum LampError {
    #[error("Bluetooth is not available or turned off. Enable Bluetooth and try again.")]
    BluetoothUnavailable,

    #[error("Could not find the selected lamp. Make sure the lamp is on and the iStrip app is closed.")]
    DeviceNotFound,

    #[error("Could not connect to the selected lamp. The iStrip app or another device may already be connected. Fully close iStrip and try Refresh Bluetooth.")]
    DeviceUnavailable,

    #[error("Not connected to a lamp. Connect first.")]
    NotConnected,

    #[error("Connection is stale. Try Refresh Bluetooth.")]
    ConnectionStale,

    #[error("Failed to send color. The lamp may have disconnected. Try Refresh Bluetooth.")]
    WriteFailure,

    #[error("BLE write gate busy.")]
    WriteBusy,

    #[error("Invalid value: {0}")]
    InvalidValue(String),

    #[error("{0}")]
    Other(String),
}

impl From<btleplug::Error> for LampError {
    fn from(e: btleplug::Error) -> Self {
        match e {
            btleplug::Error::NotConnected => LampError::NotConnected,
            btleplug::Error::PermissionDenied => {
                LampError::Other("Bluetooth permission is required to control the lamp.".to_string())
            }
            other => LampError::Other(other.to_string()),
        }
    }
}

impl serde::Serialize for LampError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
