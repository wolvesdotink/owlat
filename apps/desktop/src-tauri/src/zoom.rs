//! Page zoom: View → Actual Size / Zoom In / Zoom Out (⌘0 / ⌘= / ⌘−).
//!
//! One app-wide level, applied to every window and persisted in `view.json`
//! (its own store file, so it never races the web side's `settings.json`
//! writes), so text stays the size the user chose across windows and launches.
//! The webview's own zoom hotkeys stay off (`zoomHotkeysEnabled` defaults to
//! false); the native menu owns the shortcuts so they show up where a Mac or
//! Windows user looks for them.

use std::sync::Mutex;

use tauri::{command, AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::window;

/// Broadcast after every change so each SPA can keep chrome that must line up
/// with native pixels (the macOS traffic-light gutter) at its real size.
pub const ZOOM_CHANGED_EVENT: &str = "view://zoom";

const STORE_FILE: &str = "view.json";
const STORE_KEY: &str = "zoom";

/// The browser zoom ladder, so each step feels like the one in Safari/Chrome.
const STEPS: [f64; 11] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

/// The current app-wide zoom factor.
pub struct ZoomLevel(Mutex<f64>);

impl Default for ZoomLevel {
    fn default() -> Self {
        Self(Mutex::new(1.0))
    }
}

/// A zoom menu action.
#[derive(Clone, Copy)]
pub enum ZoomAction {
    In,
    Out,
    Reset,
}

/// Index of the ladder step closest to `factor`.
fn nearest_step(factor: f64) -> usize {
    STEPS
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| (*a - factor).abs().total_cmp(&(*b - factor).abs()))
        .map(|(i, _)| i)
        .unwrap_or(5)
}

/// The factor after applying `action` to `current`. Clamped to the ladder ends.
pub fn next_factor(current: f64, action: ZoomAction) -> f64 {
    let i = nearest_step(current);
    match action {
        ZoomAction::Reset => 1.0,
        ZoomAction::In => STEPS[(i + 1).min(STEPS.len() - 1)],
        ZoomAction::Out => STEPS[i.saturating_sub(1)],
    }
}

/// A persisted value we are willing to apply: a number on (or near) the ladder.
fn sanitize(raw: Option<f64>) -> f64 {
    match raw {
        Some(v) if v.is_finite() && (STEPS[0]..=STEPS[STEPS.len() - 1]).contains(&v) => {
            STEPS[nearest_step(v)]
        }
        _ => 1.0,
    }
}

/// Read the persisted level into state. Call once during setup, before any
/// window is zoomed.
pub fn load(app: &AppHandle) {
    let stored = app
        .store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(STORE_KEY))
        .and_then(|v| v.as_f64());
    let factor = sanitize(stored);
    if let Ok(mut level) = app.state::<ZoomLevel>().0.lock() {
        *level = factor;
    }
    window::set_titlebar_scale(app, factor);
}

fn current(app: &AppHandle) -> f64 {
    app.state::<ZoomLevel>().0.lock().map(|l| *l).unwrap_or(1.0)
}

/// Command: the current zoom factor, read by the SPA at boot (the event below
/// only covers changes made while it is running).
#[command]
pub fn zoom_level(app: AppHandle) -> f64 {
    current(&app)
}

/// Zoom a freshly built window to the app-wide level. 1.0 is the webview's own
/// default, so there is nothing to do for most users.
pub fn apply_to(app: &AppHandle, window: &WebviewWindow) {
    let factor = current(app);
    if factor != 1.0 {
        let _ = window.set_zoom(factor);
    }
}

/// Handle a View-menu zoom item: step, apply everywhere, persist.
pub fn change(app: &AppHandle, action: ZoomAction) {
    let factor = next_factor(current(app), action);
    if let Ok(mut level) = app.state::<ZoomLevel>().0.lock() {
        *level = factor;
    }
    for window in app.webview_windows().values() {
        let _ = window.set_zoom(factor);
    }
    window::set_titlebar_scale(app, factor);
    let _ = app.emit(ZOOM_CHANGED_EVENT, factor);
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(STORE_KEY, factor);
        let _ = store.save();
    }
}

#[cfg(test)]
mod tests {
    use super::{next_factor, sanitize, ZoomAction};

    #[test]
    fn steps_along_the_browser_ladder() {
        assert_eq!(next_factor(1.0, ZoomAction::In), 1.1);
        assert_eq!(next_factor(1.1, ZoomAction::In), 1.25);
        assert_eq!(next_factor(1.0, ZoomAction::Out), 0.9);
        assert_eq!(next_factor(0.9, ZoomAction::Out), 0.8);
        assert_eq!(next_factor(1.75, ZoomAction::Reset), 1.0);
    }

    #[test]
    fn clamps_at_both_ends() {
        assert_eq!(next_factor(2.0, ZoomAction::In), 2.0);
        assert_eq!(next_factor(0.5, ZoomAction::Out), 0.5);
    }

    #[test]
    fn an_off_ladder_value_snaps_to_the_nearest_step_first() {
        assert_eq!(next_factor(1.12, ZoomAction::In), 1.25);
        assert_eq!(next_factor(0.66, ZoomAction::Out), 0.5);
    }

    #[test]
    fn only_sane_persisted_values_are_applied() {
        assert_eq!(sanitize(None), 1.0);
        assert_eq!(sanitize(Some(f64::NAN)), 1.0);
        assert_eq!(sanitize(Some(7.0)), 1.0);
        assert_eq!(sanitize(Some(0.1)), 1.0);
        assert_eq!(sanitize(Some(1.25)), 1.25);
        assert_eq!(sanitize(Some(1.26)), 1.25);
    }
}
