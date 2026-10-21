use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::ambient::AmbientSettings;

fn default_transition_enabled() -> bool {
    true
}

fn default_transition_duration_ms() -> u32 {
    1200
}

fn default_loops() -> Vec<LampLoop> {
    vec![]
}

fn default_loop_sections() -> Vec<LoopSection> {
    vec![]
}

fn default_ambient_settings() -> AmbientSettings {
    AmbientSettings::default()
}

fn default_ambient_config_order() -> Vec<String> {
    vec![]
}

fn default_ambient_configs() -> Vec<AmbientConfig> {
    vec![]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientConfig {
    pub id: String,
    pub name: String,
    pub settings: AmbientSettings,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(rename = "deviceName")]
    pub device_name: String,
    #[serde(rename = "deviceId", default)]
    pub device_id: Option<String>,
    #[serde(rename = "autoConnect")]
    pub auto_connect: bool,
    #[serde(rename = "liveUpdate")]
    pub live_update: bool,
    #[serde(rename = "transitionEnabled", default = "default_transition_enabled")]
    pub transition_enabled: bool,
    #[serde(rename = "transitionDurationMs", default = "default_transition_duration_ms")]
    pub transition_duration_ms: u32,
    #[serde(rename = "activeWorkspace", default)]
    pub active_workspace: Option<String>,
    #[serde(default = "default_ambient_settings")]
    pub ambient: AmbientSettings,
    #[serde(rename = "lastColor")]
    pub last_color: LastColor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LampPreset {
    pub id: String,
    pub name: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: u8,
    pub gradient: Option<GradientColors>,
    pub notes: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradientColors {
    #[serde(rename = "borderColor")]
    pub border_color: String,
    #[serde(rename = "mainColor")]
    pub main_color: String,
    #[serde(rename = "middleColor")]
    pub middle_color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetSection {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    #[serde(rename = "presetIds")]
    pub preset_ids: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopStep {
    pub id: String,
    pub name: Option<String>,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: u8,
    pub hold_ms: u32,
    pub transition_to_next_ms: u32,
    pub transition_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LampLoop {
    pub id: String,
    pub name: String,
    pub steps: Vec<LoopStep>,
    pub notes: Option<String>,
    #[serde(rename = "sectionId")]
    pub section_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopSection {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    #[serde(rename = "loopIds")]
    pub loop_ids: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    #[serde(rename = "schemaVersion", default)]
    pub schema_version: u32,
    pub settings: AppSettings,
    pub sections: Vec<PresetSection>,
    pub presets: Vec<LampPreset>,
    #[serde(rename = "loopSections", default = "default_loop_sections")]
    pub loop_sections: Vec<LoopSection>,
    #[serde(default = "default_loops")]
    pub loops: Vec<LampLoop>,
    #[serde(rename = "ambientConfigs", default = "default_ambient_configs")]
    pub ambient_configs: Vec<AmbientConfig>,
    #[serde(rename = "ambientConfigOrder", default = "default_ambient_config_order")]
    pub ambient_config_order: Vec<String>,
}

fn state_file_path(app: &AppHandle) -> PathBuf {
    let data_dir = app.path().app_data_dir().expect("app data dir");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("state.json")
}

pub fn load(app: &AppHandle) -> Option<AppState> {
    let path = state_file_path(app);
    let contents = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn save(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let path = state_file_path(app);
    let contents = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}
