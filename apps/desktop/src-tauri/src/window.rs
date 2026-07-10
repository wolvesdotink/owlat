use tauri::{command, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Sets up close-to-tray behavior: hides the window instead of quitting.
/// On macOS, this also hides the dock icon when the window is not visible, and
/// keeps the traffic lights centered in the titlebar strip across resizes
/// (AppKit re-lays the buttons out to their defaults on window resize — see
/// `apply_traffic_light_layout`).
pub fn setup_close_handler(app: &AppHandle) {
    let app_handle = app.clone();
    if let Some(window) = app_handle.get_webview_window("main") {
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Prevent the window from being destroyed
                api.prevent_close();
                // Hide the window instead
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::Resized(_) => {
                if let Some(win) = app_handle.get_webview_window("main") {
                    apply_traffic_light_layout(&win);
                }
            }
            _ => {}
        });
    }
}

/// Shows the main window, bringing it to focus.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Navigate the main window to a specific path.
/// Uses window.location.pathname assignment for Nuxt's file-based routing.
pub fn navigate_to(window: &WebviewWindow, path: &str) {
    let js = format!(
        "if (window.__NUXT_ROUTER__) {{ window.__NUXT_ROUTER__.push('{}') }} else {{ window.location.pathname = '{}' }}",
        path, path
    );
    let _ = window.eval(&js);
}

/// Open (or focus) the dedicated compose window at `path` (e.g. "/compose" or
/// "/compose?to=…&subject=…"). Reusing an existing window full-navigates it to
/// the new path so a fresh mailto seed takes effect.
///
/// Size + position persist across launches: `tauri-plugin-window-state` (wired
/// in `main.rs`) restores every window on creation via its `on_window_ready`
/// hook and saves on move/resize/close, keyed by the window LABEL. This window's
/// label is the stable `"compose"`, and it is not in the plugin's
/// `skip_initial_state` set, so the geometry below is only the first-run default
/// — the plugin overrides it with the user's last-left frame on subsequent opens.
pub fn open_compose_window(app: &AppHandle, path: &str) {
    if let Some(win) = app.get_webview_window("compose") {
        let safe = path.replace('\'', "");
        let _ = win.eval(&format!("window.location.assign('{}')", safe));
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    // WebviewUrl::App paths are app-relative — drop any leading slash.
    let rel = path.trim_start_matches('/');
    let _ = WebviewWindowBuilder::new(app, "compose", WebviewUrl::App(rel.into()))
        .title("Compose — Owlat")
        .inner_size(720.0, 640.0)
        .min_inner_size(480.0, 380.0)
        .resizable(true)
        .build();
}

/// Command: open the compose window. Invoked from the SPA (mailto handling).
#[command]
pub fn open_compose(app: AppHandle, path: Option<String>) {
    open_compose_window(&app, &path.unwrap_or_else(|| "/compose".to_string()));
}

/// The webview titlebar strip's height, in points — MUST match `--titlebar-h`
/// (apps/web layouts/dashboard.vue) so the native traffic lights center in it.
#[cfg(target_os = "macos")]
const TITLEBAR_HEIGHT: f64 = 44.0;
/// Leading inset of the close button (the other two follow at AppKit's own
/// spacing).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS_X: f64 = 19.0;

/// Center the native traffic lights in the webview's titlebar strip.
///
/// This deliberately replaces tauri.conf.json's `trafficLightPosition`: tao
/// implements that by nudging the buttons once at creation and again on the
/// content view's `drawRect:` — but a WKWebView-backed window essentially never
/// redraws that view, and the window-state plugin's restore (any resize, zoom,
/// or theme pass) makes AppKit re-layout the titlebar back to its defaults. Net
/// effect: whether the lights sat where configured was a race. We own the
/// layout instead — same technique (grow the titlebar container to the strip
/// height, then place the buttons), but *centered* by measurement rather than
/// offset by magic numbers, re-applied from `main.rs` on every `Resized` event.
///
/// No-op in fullscreen, where macOS owns the buttons; leaving fullscreen fires
/// a resize, which re-applies the layout.
#[cfg(target_os = "macos")]
pub fn apply_traffic_light_layout(window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    if window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    // SAFETY: same contract as `apply_traffic_lights` below.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };

    // SAFETY: `standardWindowButton` returns the window-owned buttons;
    // `superview` walks to the titlebar container view that hosts them.
    let (Some(close), Some(miniaturize), Some(zoom)) = (unsafe {
        (
            ns_window.standardWindowButton(NSWindowButton::CloseButton),
            ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton),
            ns_window.standardWindowButton(NSWindowButton::ZoomButton),
        )
    }) else {
        return;
    };
    let Some(container) = (unsafe { close.superview() }).and_then(|v| unsafe { v.superview() })
    else {
        return;
    };

    // Grow the titlebar container to the strip height, pinned to the top edge
    // (AppKit view coords are bottom-up).
    let window_height = ns_window.frame().size.height;
    let mut container_rect = container.frame();
    container_rect.size.height = TITLEBAR_HEIGHT;
    container_rect.origin.y = window_height - TITLEBAR_HEIGHT;
    container.setFrame(container_rect);

    // Center each button vertically in the strip; keep AppKit's own spacing.
    let button_height = close.frame().size.height;
    let spacing = miniaturize.frame().origin.x - close.frame().origin.x;
    let button_y = (TITLEBAR_HEIGHT - button_height) / 2.0;
    for (i, button) in [&close, &miniaturize, &zoom].into_iter().enumerate() {
        let mut rect = button.frame();
        rect.origin.x = TRAFFIC_LIGHTS_X + (i as f64) * spacing;
        rect.origin.y = button_y;
        button.setFrameOrigin(rect.origin);
    }
}

/// Width of the native identity-frame ring, in points — mirrors the retired
/// CSS `--ws-frame-width` (assets/css/desktop.css).
#[cfg(target_os = "macos")]
const ACCENT_FRAME_WIDTH: f64 = 5.0;
/// Ring opacity — mirrors the CSS `color-mix(in srgb, accent 55%, transparent)`.
#[cfg(target_os = "macos")]
const ACCENT_FRAME_ALPHA: f64 = 0.55;
/// Outer-radius fallback when the theme frame's layer radius can't be read —
/// the value the CSS ring used to hard-code.
#[cfg(target_os = "macos")]
const ACCENT_FRAME_RADIUS_FALLBACK: f64 = 10.0;

/// `"#rrggbb"` → sRGB components. Workspace accents are always 6-digit hex
/// (see WORKSPACE_ACCENTS in apps/web); anything else is ignored.
#[cfg(target_os = "macos")]
fn parse_hex_color(hex: &str) -> Option<(f64, f64, f64)> {
    let hex = hex.trim().strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let n = u32::from_str_radix(hex, 16).ok()?;
    Some((
        ((n >> 16) & 0xff) as f64 / 255.0,
        ((n >> 8) & 0xff) as f64 / 255.0,
        (n & 0xff) as f64 / 255.0,
    ))
}

/// Draw the per-workspace identity frame in the NATIVE window instead of the
/// page (the way Arc's chrome is native rather than painted by the web view).
///
/// The ring is a `CALayer` border added above the webview's layer on the
/// window's content view. Only AppKit knows the window's true rounded-corner
/// radius — the CSS ring this replaces hard-coded 10px and visibly drifted from
/// the OS shape — so the outer curvature is read off the theme frame's layer at
/// apply time. A layer border draws its inner edge at `radius − width` by
/// construction, which is exactly the "inner radius matches the outer minus the
/// border width" rule. Layers receive no events, so clicks, drags and the
/// traffic lights (siblings above the content view) are untouched.
///
/// `color: None` leaves the current border color alone (visibility-only calls,
/// e.g. the fullscreen collapse); a color that fails to parse is ignored. The
/// layer is created lazily on the first call that carries a color.
/// The window's rounded-corner radius, in points. Two probes, then a fallback:
/// the theme frame's layer radius (public property read), then the theme
/// frame's private `-_cornerRadius` (guarded by `respondsToSelector:`; the app
/// already opts into `macOSPrivateApi`). Logged once at creation so a future
/// macOS change is diagnosable from the dev console.
#[cfg(target_os = "macos")]
fn window_corner_radius(theme_frame: Option<&objc2_app_kit::NSView>) -> f64 {
    use objc2::{msg_send, sel};

    let Some(frame) = theme_frame else {
        return ACCENT_FRAME_RADIUS_FALLBACK;
    };
    if let Some(radius) = frame.layer().map(|l| l.cornerRadius()).filter(|r| *r > 0.0) {
        return radius;
    }
    // SAFETY: `respondsToSelector:` is safe on any NSObject; `_cornerRadius`
    // (NSThemeFrame) takes no arguments and returns a CGFloat, and is only
    // called when the probe confirms it exists.
    let radius = unsafe {
        let responds: bool = msg_send![frame, respondsToSelector: sel!(_cornerRadius)];
        if responds {
            msg_send![frame, _cornerRadius]
        } else {
            0.0f64
        }
    };
    if radius > 0.0 {
        radius
    } else {
        ACCENT_FRAME_RADIUS_FALLBACK
    }
}

#[cfg(target_os = "macos")]
fn apply_accent_frame(window: &WebviewWindow, color: Option<&str>, visible: bool) {
    use objc2_app_kit::{NSColor, NSWindow};
    use objc2_foundation::NSString;
    use objc2_quartz_core::{kCACornerCurveContinuous, CAAutoresizingMask, CALayer};

    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    // SAFETY: same contract as `apply_traffic_lights` below — the pointer is
    // this window's NSWindow, valid for the window's lifetime, main thread only.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let Some(content) = ns_window.contentView() else {
        return;
    };
    content.setWantsLayer(true);
    let Some(root) = content.layer() else {
        return;
    };

    let layer_name = NSString::from_str("owlat-accent-frame");
    // SAFETY: `sublayers` is a plain CALayer property read.
    let existing = unsafe { root.sublayers() }.and_then(|subs| {
        subs.iter()
            .find(|l| l.name().is_some_and(|n| n == layer_name))
    });

    let layer = match existing {
        Some(layer) => layer,
        // Nothing drawn yet and nothing to draw — visibility toggles are moot.
        None if color.is_none() => return,
        None => {
            let layer = CALayer::new();
            layer.setName(Some(&layer_name));
            layer.setFrame(root.bounds());
            // Track window resizes without re-entering Rust: the content view
            // resizes its root layer, which autoresizes this sublayer.
            layer.setAutoresizingMask(
                CAAutoresizingMask::LayerWidthSizable | CAAutoresizingMask::LayerHeightSizable,
            );
            layer.setBorderWidth(ACCENT_FRAME_WIDTH);
            // Above the webview's layer (z 0), below nothing that matters —
            // the traffic lights live outside the content view entirely.
            layer.setZPosition(1_000.0);
            let theme_frame = unsafe { content.superview() };
            let radius = window_corner_radius(theme_frame.as_deref());
            eprintln!("[owlat] accent frame corner radius: {radius}");
            layer.setCornerRadius(radius);
            // macOS windows round with the continuous (squircle) curve, not a
            // circular arc — a circular ring at the same radius still visibly
            // mismatches the window corner.
            layer.setCornerCurve(unsafe { kCACornerCurveContinuous });
            layer.setMasksToBounds(true);
            root.addSublayer(&layer);
            layer
        }
    };

    if let Some((r, g, b)) = color.and_then(parse_hex_color) {
        let ns_color = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, ACCENT_FRAME_ALPHA);
        layer.setBorderColor(Some(&ns_color.CGColor()));
    }
    layer.setHidden(!visible);
}

/// Command: paint / recolor / toggle the native workspace identity frame. The
/// webview mirrors every accent change through here (lib/desktop/
/// workspaceAccent.ts) and collapses the ring in native fullscreen (the boot
/// plugin's fullscreen watcher). No-op on Windows/Linux, where the frame is
/// still painted by CSS (those windows are undecorated — no OS radius to chase).
#[cfg(target_os = "macos")]
#[command]
pub fn set_accent_frame(
    window: WebviewWindow,
    color: Option<String>,
    visible: bool,
) -> Result<(), String> {
    let win = window.clone();
    window
        .run_on_main_thread(move || apply_accent_frame(&win, color.as_deref(), visible))
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[command]
pub fn set_accent_frame(
    _window: WebviewWindow,
    _color: Option<String>,
    _visible: bool,
) -> Result<(), String> {
    Ok(())
}

/// Show or hide the three native window buttons (close / miniaturize / zoom) on
/// the given window's NSWindow. Must run on the main thread.
///
/// We only refuse the *hide* direction while fullscreen: there macOS owns the
/// buttons (they live behind the menu-bar reveal bar) and hiding them would
/// strand the fullscreen exit affordance. Restoring them to visible matches the
/// native fullscreen state, so it is safe — and it is what keeps the buttons
/// from being permanently lost when the sidebar-owning layout tears down while
/// fullscreen.
#[cfg(target_os = "macos")]
fn apply_traffic_lights(window: &WebviewWindow, visible: bool) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    if !visible && window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    // SAFETY: `ns_window()` returns this webview window's NSWindow pointer on
    // macOS; it stays valid for the window's lifetime and we only touch it here
    // on the main thread.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let hidden = !visible;
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        // SAFETY: `standardWindowButton` returns the window-owned NSButton (or
        // None); `setHidden` is a plain NSView setter.
        if let Some(button) = unsafe { ns_window.standardWindowButton(kind) } {
            unsafe { button.setHidden(hidden) };
        }
    }
}

/// Command: toggle the native macOS traffic-light buttons so they can follow the
/// sidebar's hidden state. Runs the NSWindow work on the main thread. No-op on
/// Windows/Linux (their custom titlebar buttons are unaffected).
#[cfg(target_os = "macos")]
#[command]
pub fn set_traffic_lights_visible(window: WebviewWindow, visible: bool) -> Result<(), String> {
    let win = window.clone();
    window
        .run_on_main_thread(move || apply_traffic_lights(&win, visible))
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[command]
pub fn set_traffic_lights_visible(_window: WebviewWindow, _visible: bool) -> Result<(), String> {
    Ok(())
}
