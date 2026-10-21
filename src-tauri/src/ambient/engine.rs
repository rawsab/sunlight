use super::adaptive::AdaptiveController;
use super::capture::{CapturePollResult, CaptureSession};
use super::color::{downgrade_quality, ColorProcessor, ProcessedFrame};
use super::metrics::AmbientMetricsCollector;
use super::permission::{
    check_screen_capture_permission, request_screen_capture_permission,
    screen_capture_denied_message,
};
use super::types::{
    rgb_to_hex, AmbientDebugMetrics, AmbientFrameEvent, AmbientOutputRate, AmbientSettings,
    AmbientStatus, AmbientStopReason, AmbientStoppedEvent, ScreenCapturePermission,
};
use crate::ble_write::{write_color_if_connected, WritePriority};
use crate::errors::LampError;
use crate::state::{ConnectionStatus, SharedLampState};

use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex, RwLock};
use tokio::task::JoinHandle;

#[derive(Clone)]
struct RuntimeConfig {
    settings: AmbientSettings,
    brightness: u8,
}

#[derive(Clone, Copy)]
struct PendingSend {
    r: u8,
    g: u8,
    b: u8,
    brightness: u8,
    frame: ProcessedFrame,
}

type BleWriteHandle = JoinHandle<(Result<(), LampError>, f32, PendingSend)>;

const BLE_KEEPALIVE: Duration = Duration::from_secs(15);
const BLE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CAPTURE_WAIT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CONSECUTIVE_CAPTURE_FAILURES: u32 = 15;
const MAX_NO_SUCCESSFUL_FRAME: Duration = Duration::from_secs(8);
const CAPTURE_FAIL_MESSAGE: &str = "Ambient Mode stopped because screen capture stopped responding. Try restarting Ambient Mode or lowering the output rate.";

struct AmbientBleOutput {
    in_flight: Option<BleWriteHandle>,
    in_flight_started: Option<Instant>,
    pending: Option<PendingSend>,
    last_ble_send: Instant,
}

impl AmbientBleOutput {
    fn new() -> Self {
        Self {
            in_flight: None,
            in_flight_started: None,
            pending: None,
            last_ble_send: Instant::now() - Duration::from_secs(1),
        }
    }

    fn is_busy(&self) -> bool {
        self.in_flight
            .as_ref()
            .is_some_and(|h| !h.is_finished())
    }

    fn clear(&mut self) {
        self.pending = None;
        self.in_flight_started = None;
    }
}

struct LoopExit {
    reason: AmbientStopReason,
    message: Option<String>,
    stopped_already_emitted: bool,
}

pub struct AmbientEngine {
    pub(crate) status: AmbientStatus,
    config: Arc<RwLock<RuntimeConfig>>,
    stop_tx: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
    quality_downgraded: bool,
}

impl Default for AmbientEngine {
    fn default() -> Self {
        Self {
            status: AmbientStatus::Inactive,
            config: Arc::new(RwLock::new(RuntimeConfig {
                settings: AmbientSettings::default(),
                brightness: 64,
            })),
            stop_tx: None,
            task: None,
            quality_downgraded: false,
        }
    }
}

pub type SharedAmbientEngine = Arc<Mutex<AmbientEngine>>;

impl AmbientEngine {
    pub fn status(&self) -> AmbientStatus {
        if matches!(
            self.status,
            AmbientStatus::StartingCapture | AmbientStatus::Running
        ) && self.task.as_ref().is_some_and(|t| t.is_finished())
        {
            return AmbientStatus::Stopped;
        }
        self.status
    }

    pub async fn start(
        &mut self,
        app: AppHandle,
        lamp_state: SharedLampState,
        settings: AmbientSettings,
        brightness: u8,
        engine_handle: SharedAmbientEngine,
    ) -> Result<(), String> {
        if self.status == AmbientStatus::Running
            || self.status == AmbientStatus::StartingCapture
            || self.status == AmbientStatus::CheckingPermission
        {
            if self.task.as_ref().is_none_or(|t| !t.is_finished()) {
                return Ok(());
            }
            self.task = None;
            self.status = AmbientStatus::Stopped;
        }

        {
            let s = lamp_state.lock().await;
            if s.status != ConnectionStatus::Connected {
                return Err("Connect to the selected lamp before starting Ambient Mode.".to_string());
            }
        }

        self.stop_internal().await;
        self.quality_downgraded = false;
        self.status = AmbientStatus::CheckingPermission;
        emit_status(&app, self.status);

        let permission = check_screen_capture_permission();
        if permission != ScreenCapturePermission::Granted {
            self.status = AmbientStatus::WaitingForPermission;
            emit_status(&app, self.status);
            let requested = request_screen_capture_permission();
            if requested != ScreenCapturePermission::Granted {
                self.status = AmbientStatus::Failed;
                emit_status(&app, self.status);
                return Err(screen_capture_denied_message());
            }
        }

        {
            let mut cfg = self.config.write().await;
            cfg.settings = settings;
            cfg.brightness = brightness;
        }

        self.status = AmbientStatus::StartingCapture;
        emit_status(&app, self.status);

        let (stop_tx, stop_rx) = watch::channel(false);
        self.stop_tx = Some(stop_tx);
        let config = self.config.clone();

        let handle = tokio::spawn(async move {
            let exit = run_ambient_loop(app.clone(), lamp_state, config, stop_rx).await;
            finalize_ambient_loop(&app, &engine_handle, exit).await;
        });
        self.task = Some(handle);
        self.status = AmbientStatus::Running;
        Ok(())
    }

    pub async fn stop(&mut self, app: Option<&AppHandle>, reason: AmbientStopReason, message: Option<String>) {
        self.stop_internal().await;
        self.status = AmbientStatus::Stopped;
        if let Some(app) = app {
            emit_status(app, self.status);
            let _ = app.emit(
                "ambient://stopped",
                AmbientStoppedEvent { reason, message },
            );
        }
    }

    async fn stop_internal(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(true);
        }
        if let Some(task) = self.task.take() {
            let mut task = task;
            tokio::select! {
                _ = &mut task => {}
                _ = tokio::time::sleep(Duration::from_millis(1500)) => {
                    task.abort();
                }
            }
            let _ = task.await;
        }
    }

    pub async fn update_settings(&self, settings: AmbientSettings, brightness: Option<u8>) {
        let mut cfg = self.config.write().await;
        cfg.settings = settings;
        if let Some(b) = brightness {
            cfg.brightness = b;
        }
    }
}

async fn run_ambient_loop(
    app: AppHandle,
    lamp_state: SharedLampState,
    config: Arc<RwLock<RuntimeConfig>>,
    mut stop_rx: watch::Receiver<bool>,
) -> LoopExit {
    let initial = config.read().await.clone();
    let (width, height) = initial.settings.dimensions();

    let mut capture = match CaptureSession::start(width, height).await {
        Ok(c) => c,
        Err(e) => {
            return LoopExit {
                reason: AmbientStopReason::CaptureFailed,
                message: Some(if e.contains("permission") {
                    e
                } else {
                    "Could not capture the screen. Check Screen Recording permission and try again.".to_string()
                }),
                stopped_already_emitted: false,
            };
        }
    };

    let _ = app.emit("ambient://status", serde_json::json!({ "status": "running" }));

    let mut processor = ColorProcessor::default();
    let mut ble_output = AmbientBleOutput::new();
    let mut metrics = AmbientMetricsCollector::default();
    let mut processing_samples: Vec<f32> = Vec::with_capacity(30);
    let mut quality_downgraded = false;
    let mut needs_capture_restart = false;
    let mut current_dims = (width, height);
    let mut last_debug_emit = Instant::now() - Duration::from_secs(1);
    let mut last_adaptive_tick = Instant::now() - Duration::from_secs(1);
    let mut last_output_rate: Option<AmbientOutputRate> = None;
    let mut adaptive: Option<AdaptiveController> = None;
    let mut last_successful_frame = Instant::now();

    let exit = 'ambient: loop {
        if *stop_rx.borrow() {
            break 'ambient LoopExit {
                reason: AmbientStopReason::User,
                message: None,
                stopped_already_emitted: true,
            };
        }

        if !poll_ble_write(&mut ble_output, &mut processor, &mut metrics, &lamp_state, &app).await
        {
            break 'ambient LoopExit {
                reason: AmbientStopReason::ConnectionLost,
                message: Some(
                    "Ambient Mode stopped because the lamp connection became stale.".to_string(),
                ),
                stopped_already_emitted: true,
            };
        }

        metrics.set_ble_writes_in_flight(if ble_output.is_busy() { 1 } else { 0 });
        metrics.set_capture_in_flight(capture.capture_in_flight());

        if !capture.has_in_flight() {
            capture.begin_capture();
            metrics.set_capture_in_flight(capture.capture_in_flight());
        }

        let capture_start = Instant::now();
        let poll_result = tokio::select! {
            biased;
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    break 'ambient LoopExit {
                        reason: AmbientStopReason::User,
                        message: None,
                        stopped_already_emitted: true,
                    };
                }
                continue;
            }
            result = wait_for_capture(&mut capture) => result,
        };

        match poll_result {
            Ok(CapturePollResult::Ready(frame)) => {
                last_successful_frame = Instant::now();
                metrics.set_capture_backoff_active(false);
                metrics.record_capture(frame.capture_ms, frame.downsample_ms);

                let runtime = config.read().await.clone();
                let settings = &runtime.settings;

                if last_output_rate.as_ref() != Some(&settings.output_fps) {
                    metrics.reset_sustain_notice();
                    last_output_rate = Some(settings.output_fps.clone());
                    adaptive = if settings.is_adaptive_max() {
                        Some(AdaptiveController::new())
                    } else {
                        None
                    };
                }

                let (output_interval_ms, sample_interval_ms, _target_capture_fps, _target_output_fps) =
                    if let Some(ctrl) = adaptive.as_ref() {
                        (
                            ctrl.output_interval_ms(),
                            ctrl.capture_interval_ms(),
                            ctrl.capture_target_fps() as f32,
                            ctrl.output_target_fps() as f32,
                        )
                    } else {
                        (
                            settings.output_interval_ms(),
                            settings.target_sample_interval_ms(),
                            settings.target_capture_fps(),
                            settings.target_output_fps(),
                        )
                    };

                if needs_capture_restart {
                    let (w, h) = settings.dimensions();
                    current_dims = (w, h);
                    capture.width = w;
                    capture.height = h;
                    processor.reset();
                    needs_capture_restart = false;
                } else if settings.dimensions() != current_dims {
                    needs_capture_restart = true;
                    continue;
                }

                let process_start = Instant::now();
                let (processed, algorithm_ms) = processor.process_frame_timed(
                    &frame.pixels,
                    frame.width,
                    frame.height,
                    frame.bytes_per_row,
                    settings,
                    runtime.brightness,
                );
                let processing_ms = process_start.elapsed().as_secs_f32() * 1000.0;
                metrics.record_processing(processing_ms, algorithm_ms);

                let (color_delta, brightness_delta) = processor.compute_deltas(&processed);
                metrics.set_output_deltas(color_delta, brightness_delta);
                metrics.set_output_state(processed.brightness, processed.screen_intensity);

                processing_samples.push(processing_ms);
                if processing_samples.len() > 30 {
                    processing_samples.remove(0);
                }

                if !quality_downgraded && processing_samples.len() >= 30 {
                    let avg: f32 =
                        processing_samples.iter().sum::<f32>() / processing_samples.len() as f32;
                    if avg > 33.0 {
                        let mut cfg = config.write().await;
                        if downgrade_quality(&mut cfg.settings) {
                            quality_downgraded = true;
                            needs_capture_restart = true;
                            let _ = app.emit(
                                "ambient://notice",
                                serde_json::json!({
                                    "message": "Ambient Mode lowered capture quality to reduce CPU usage."
                                }),
                            );
                            continue;
                        }
                    }
                }

                let output_interval = Duration::from_millis(output_interval_ms);
                let r = processed.rgb.r.clamp(0.0, 255.0) as u8;
                let g = processed.rgb.g.clamp(0.0, 255.0) as u8;
                let b = processed.rgb.b.clamp(0.0, 255.0) as u8;
                let brightness = processed.brightness;
                let send = PendingSend {
                    r,
                    g,
                    b,
                    brightness,
                    frame: processed,
                };

                let needs_keepalive = ble_output.last_ble_send.elapsed() >= BLE_KEEPALIVE;

                if ble_output.last_ble_send.elapsed() >= output_interval {
                    if processor.is_duplicate(&send.frame) && !needs_keepalive {
                        metrics.record_skip_duplicate();
                    } else if needs_keepalive || processor.should_send(&send.frame, settings) {
                        if ble_output.is_busy() {
                            metrics.record_ble_busy_skip();
                            if ble_output.pending.is_some() {
                                metrics.record_dropped_frame();
                            }
                            ble_output.pending = Some(send);
                        } else {
                            ble_output.last_ble_send = Instant::now();
                            spawn_ble_write(&mut ble_output, &lamp_state, send);
                        }
                    } else {
                        metrics.record_skip_delta();
                    }
                } else {
                    metrics.record_skip_rate_limit();
                }

                let frame_event = AmbientFrameEvent {
                    r,
                    g,
                    b,
                    hex: rgb_to_hex(r, g, b),
                    computed_brightness: Some(send.frame.brightness),
                    screen_intensity: Some(send.frame.screen_intensity),
                };
                let _ = app.emit("ambient://frame", frame_event);

                if last_adaptive_tick.elapsed() >= Duration::from_millis(500) {
                    last_adaptive_tick = Instant::now();
                    if let Some(ctrl) = adaptive.as_mut() {
                        ctrl.tick(&metrics, Instant::now());
                    }
                }

                if settings.debug && last_debug_emit.elapsed() >= Duration::from_millis(500) {
                    last_debug_emit = Instant::now();
                    let (debug_capture_fps, debug_output_fps) =
                        effective_target_fps(settings, adaptive.as_ref());
                    let adaptive_snap = adaptive.as_ref().map(AdaptiveController::snapshot);
                    let debug_metrics = metrics.snapshot_with_pipeline(
                        settings,
                        send.frame.metrics.edge_intensity,
                        send.frame.metrics.center_intensity,
                        send.frame.metrics.spatial_intensity,
                        send.frame.metrics.highlight_intensity,
                        send.frame.metrics.smoothed_brightness,
                        send.frame.target_brightness,
                        debug_capture_fps,
                        debug_output_fps,
                        adaptive_snap.as_ref(),
                    );
                    emit_debug_metrics(&app, &debug_metrics, settings, &mut metrics);
                }

                let sample_interval = Duration::from_millis(sample_interval_ms);
                let elapsed_since_capture = capture_start.elapsed();
                if elapsed_since_capture < sample_interval {
                    tokio::time::sleep(sample_interval - elapsed_since_capture).await;
                    if *stop_rx.borrow() {
                        break 'ambient LoopExit {
                            reason: AmbientStopReason::User,
                            message: None,
                            stopped_already_emitted: true,
                        };
                    }
                }
            }
            Ok(CapturePollResult::InFlight) => {
                // Should not happen after wait_for_capture completes.
                continue;
            }
            Ok(CapturePollResult::StaleDiscarded) => {
                metrics.record_stale_capture_discarded();
                metrics.set_capture_in_flight(capture.capture_in_flight());
            }
            Ok(CapturePollResult::Failed) => {
                metrics.record_capture_failure();
                if let Some(exit) =
                    check_capture_failure_stop(&metrics, last_successful_frame)
                {
                    break 'ambient exit;
                }
                apply_capture_backoff(&mut metrics).await;
            }
            Err(CaptureWaitError::Timeout) => {
                metrics.record_capture_timeout();
                capture.invalidate_in_flight();
                if let Some(exit) =
                    check_capture_failure_stop(&metrics, last_successful_frame)
                {
                    break 'ambient exit;
                }
                apply_capture_backoff(&mut metrics).await;
            }
        }
    };

    cleanup_ambient_resources(&mut capture, &mut ble_output, &mut metrics, &exit).await;
    exit
}

async fn wait_for_capture(capture: &mut CaptureSession) -> Result<CapturePollResult, CaptureWaitError> {
    tokio::time::timeout(CAPTURE_WAIT_TIMEOUT, async {
        loop {
            match capture.poll().await {
                CapturePollResult::InFlight => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                other => return other,
            }
        }
    })
    .await
    .map_err(|_| CaptureWaitError::Timeout)
}

#[derive(Debug)]
enum CaptureWaitError {
    Timeout,
}

fn capture_backoff_ms(consecutive_failures: u32) -> u64 {
    if consecutive_failures <= 3 {
        150
    } else if consecutive_failures <= 8 {
        250
    } else {
        750
    }
}

fn check_capture_failure_stop(
    metrics: &AmbientMetricsCollector,
    last_successful_frame: Instant,
) -> Option<LoopExit> {
    if let Some(err) = capture_error_hint() {
        return Some(LoopExit {
            reason: AmbientStopReason::Permission,
            message: Some(err),
            stopped_already_emitted: false,
        });
    }

    if metrics.consecutive_capture_failures() >= MAX_CONSECUTIVE_CAPTURE_FAILURES
        || last_successful_frame.elapsed() >= MAX_NO_SUCCESSFUL_FRAME
    {
        return Some(LoopExit {
            reason: AmbientStopReason::CaptureFailed,
            message: Some(CAPTURE_FAIL_MESSAGE.to_string()),
            stopped_already_emitted: false,
        });
    }

    None
}

async fn apply_capture_backoff(metrics: &mut AmbientMetricsCollector) {
    let backoff = capture_backoff_ms(metrics.consecutive_capture_failures());
    metrics.set_capture_backoff_active(true);
    tokio::time::sleep(Duration::from_millis(backoff)).await;
    metrics.set_capture_backoff_active(false);
}

async fn cleanup_ambient_resources(
    capture: &mut CaptureSession,
    ble_output: &mut AmbientBleOutput,
    metrics: &mut AmbientMetricsCollector,
    exit: &LoopExit,
) {
    if let Some(handle) = ble_output.in_flight.take() {
        let _ = tokio::time::timeout(BLE_WRITE_TIMEOUT, handle).await;
    }
    ble_output.clear();
    capture.stop().await;
    metrics.set_capture_in_flight(false);
    metrics.set_last_stop_reason(&format!("{:?}", exit.reason).to_lowercase());
}

async fn finalize_ambient_loop(
    app: &AppHandle,
    engine: &SharedAmbientEngine,
    exit: LoopExit,
) {
    let mut eng = engine.lock().await;
    eng.status = AmbientStatus::Stopped;
    eng.task = None;
    eng.stop_tx = None;

    let _ = app.emit("ambient://status", serde_json::json!({ "status": "stopped" }));

    if !exit.stopped_already_emitted {
        let _ = app.emit(
            "ambient://stopped",
            AmbientStoppedEvent {
                reason: exit.reason,
                message: exit.message,
            },
        );
    }
}

fn spawn_ble_write(
    ble_output: &mut AmbientBleOutput,
    lamp_state: &SharedLampState,
    send: PendingSend,
) {
    let state = lamp_state.clone();
    let write_start = Instant::now();
    ble_output.in_flight_started = Some(Instant::now());
    ble_output.in_flight = Some(tokio::spawn(async move {
        let result = write_color_if_connected(
            &state,
            send.r,
            send.g,
            send.b,
            send.brightness,
            WritePriority::Ambient,
        )
        .await;
        let duration_ms = write_start.elapsed().as_secs_f32() * 1000.0;
        (result, duration_ms, send)
    }));
}

async fn poll_ble_write(
    ble_output: &mut AmbientBleOutput,
    processor: &mut ColorProcessor,
    metrics: &mut AmbientMetricsCollector,
    lamp_state: &SharedLampState,
    app: &AppHandle,
) -> bool {
    let Some(handle) = ble_output.in_flight.take() else {
        if !ble_output.is_busy() {
            if let Some(pending) = ble_output.pending.take() {
                ble_output.last_ble_send = Instant::now();
                spawn_ble_write(ble_output, lamp_state, pending);
            }
        }
        return true;
    };

    if !handle.is_finished() {
        if ble_output
            .in_flight_started
            .is_some_and(|t| t.elapsed() >= BLE_WRITE_TIMEOUT)
        {
            handle.abort();
            metrics.record_ble_failure();
            metrics.record_skip_stale();
            emit_connection_lost(app);
            return false;
        }
        ble_output.in_flight = Some(handle);
        return true;
    }

    ble_output.in_flight_started = None;

    match handle.await {
        Ok((Ok(()), duration_ms, send)) => {
            metrics.record_ble_write(duration_ms);
            processor.mark_sent(&send.frame);
            if let Some(pending) = ble_output.pending.take() {
                ble_output.last_ble_send = Instant::now();
                spawn_ble_write(ble_output, lamp_state, pending);
            }
        }
        Ok((Err(LampError::WriteBusy), _, send)) => {
            metrics.record_ble_busy_skip();
            ble_output.pending = Some(send);
        }
        Ok((
            Err(LampError::ConnectionStale | LampError::NotConnected | LampError::WriteFailure),
            _,
            _,
        ))
        | Ok((Err(_), _, _))
        | Err(_) => {
            metrics.record_ble_failure();
            metrics.record_skip_stale();
            emit_connection_lost(app);
            return false;
        }
    }

    true
}

fn effective_target_fps(
    settings: &AmbientSettings,
    adaptive: Option<&AdaptiveController>,
) -> (f32, f32) {
    if let Some(ctrl) = adaptive {
        (
            ctrl.capture_target_fps() as f32,
            ctrl.output_target_fps() as f32,
        )
    } else {
        (
            settings.target_capture_fps(),
            settings.target_output_fps(),
        )
    }
}

fn emit_debug_metrics(
    app: &AppHandle,
    debug_metrics: &AmbientDebugMetrics,
    settings: &AmbientSettings,
    metrics: &mut AmbientMetricsCollector,
) {
    if !settings.is_adaptive_max()
        && metrics.check_sustain_notice(
            debug_metrics.target_output_fps,
            debug_metrics.actual_output_fps,
        )
    {
        let target = debug_metrics.target_output_fps as u8;
        let _ = app.emit(
            "ambient://notice",
            serde_json::json!({
                "message": format!(
                    "Ambient Mode could not sustain {} FPS. Try 15 FPS or Balanced quality.",
                    target
                )
            }),
        );
    }
    let _ = app.emit("ambient://debug-metrics", debug_metrics.clone());
}

fn emit_connection_lost(app: &AppHandle) {
    let _ = app.emit(
        "ambient://stopped",
        AmbientStoppedEvent {
            reason: AmbientStopReason::ConnectionLost,
            message: Some(
                "Ambient Mode stopped because the lamp connection became stale.".to_string(),
            ),
        },
    );
}

fn emit_status(app: &AppHandle, status: AmbientStatus) {
    let _ = app.emit(
        "ambient://status",
        serde_json::json!({ "status": status }),
    );
}

fn capture_error_hint() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if check_screen_capture_permission() != super::types::ScreenCapturePermission::Granted {
            return Some(screen_capture_denied_message());
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some("Ambient Mode requires macOS.".to_string())
    }
}

pub async fn stop_ambient_engine(
    engine: &SharedAmbientEngine,
    app: Option<&AppHandle>,
    reason: AmbientStopReason,
    message: Option<String>,
) {
    let mut eng = engine.lock().await;
    eng.stop(app, reason, message).await;
    eng.status = AmbientStatus::Stopped;
}
