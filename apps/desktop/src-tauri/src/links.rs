//! Keep the webview an app, not a browser.
//!
//! Every Owlat window runs the bundled SPA; nothing else should ever load in
//! it. Two webview hooks enforce that, attached to each window at build time
//! (`guard`):
//!
//! - `on_new_window` (`target="_blank"`, `window.open`): with no handler,
//!   WKWebView (macOS) silently drops the request, so a link in an email or a
//!   "View online" button did nothing, and WebView2 (Windows) opened a bare
//!   browser window with no Owlat chrome. Web links now go to the user's default
//!   browser; an app route (a "open in new tab" of our own page) navigates the
//!   requesting window instead, since the desktop app has no tabs.
//! - `on_navigation` (a plain `<a href>` or `location.href = …`): an external
//!   page would otherwise replace the whole app inside the window, with no
//!   address bar and no way back. It is handed to the browser and the app stays
//!   where it was.
//!
//! `mailto:` in either case is forwarded to the main window's SPA, which runs
//! the same parser as the OS-level `mailto:` deep link and opens Owlat's own
//! compose window — never the system's other mail client.

use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse},
    AppHandle, Emitter, Manager, Url, WebviewWindowBuilder, Wry,
};
use tauri_plugin_shell::ShellExt;

use crate::window;

/// Event the main window's SPA listens for to open a `mailto:` in the compose
/// window (apps/web plugins/1.desktop-menu.client.ts).
pub const OPEN_MAILTO_EVENT: &str = "link://mailto";

/// Where a URL the webview wants to load belongs.
#[derive(Debug, PartialEq, Eq)]
pub enum LinkTarget {
    /// The bundled SPA itself (any route of it).
    App,
    /// A web page or phone number — the operating system's job.
    External,
    /// A `mailto:` link — Owlat's own compose window.
    Mail,
    /// Browser-internal documents the SPA creates for itself (`about:srcdoc`
    /// for the email reader frame, `blob:` / `data:` downloads and previews).
    Internal,
    /// Anything else (`file:`, `javascript:`, unknown custom schemes): refused.
    Unknown,
}

/// Classify a URL by scheme and host. `tauri://localhost` is the app on macOS
/// and Linux, `http(s)://tauri.localhost` on Windows. Debug builds load the Nuxt
/// dev server (`devUrl`), so localhost also counts as the app there — only there.
pub fn classify(url: &Url) -> LinkTarget {
    match url.scheme() {
        "tauri" => LinkTarget::App,
        "about" | "blob" | "data" => LinkTarget::Internal,
        "mailto" => LinkTarget::Mail,
        "tel" => LinkTarget::External,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => LinkTarget::App,
            Some("localhost" | "127.0.0.1") if cfg!(debug_assertions) => LinkTarget::App,
            _ => LinkTarget::External,
        },
        _ => LinkTarget::Unknown,
    }
}

/// The path + query + fragment of an app URL, for an in-app router push.
fn app_route(url: &Url) -> String {
    let mut route = url.path().to_string();
    if let Some(query) = url.query() {
        route.push('?');
        route.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        route.push('#');
        route.push_str(fragment);
    }
    route
}

// `Shell::open` is deprecated in favour of tauri-plugin-opener; this app ships
// tauri-plugin-shell (see menu.rs for the same call).
#[allow(deprecated)]
fn open_in_os(app: &AppHandle, url: &Url) {
    if let Err(e) = app.shell().open(url.as_str(), None) {
        eprintln!(
            "[owlat] could not open {} in the default app: {e}",
            url.scheme()
        );
    }
}

fn forward_mailto(app: &AppHandle, url: &Url) {
    window::show_main_window(app);
    let _ = app.emit_to("main", OPEN_MAILTO_EVENT, url.as_str());
}

/// Attach the link policy to a window about to be built. `label` is the
/// window's own label, so an app route asked for in a "new window" lands in the
/// window that asked.
pub fn guard<'a, M: Manager<Wry>>(
    builder: WebviewWindowBuilder<'a, Wry, M>,
    app: &AppHandle,
    label: &str,
) -> WebviewWindowBuilder<'a, Wry, M> {
    let nav_app = app.clone();
    let new_app = app.clone();
    let label = label.to_string();
    builder
        .on_navigation(move |url| match classify(url) {
            LinkTarget::App | LinkTarget::Internal => true,
            LinkTarget::External => {
                open_in_os(&nav_app, url);
                false
            }
            LinkTarget::Mail => {
                forward_mailto(&nav_app, url);
                false
            }
            LinkTarget::Unknown => false,
        })
        .on_new_window(move |url, _features: NewWindowFeatures| {
            match classify(&url) {
                LinkTarget::External => open_in_os(&new_app, &url),
                LinkTarget::Mail => forward_mailto(&new_app, &url),
                LinkTarget::App => {
                    if let Some(win) = new_app.get_webview_window(&label) {
                        window::navigate_to(&win, &app_route(&url));
                    }
                }
                // Windows used to open blob:/about: popups (attachment preview,
                // a blank tab filled in later) in a bare WebView2 window; keep
                // that rather than lose the preview. macOS and Linux never
                // opened them, and still don't.
                LinkTarget::Internal if cfg!(windows) => return NewWindowResponse::Allow,
                LinkTarget::Internal | LinkTarget::Unknown => {}
            }
            NewWindowResponse::Deny
        })
}

#[cfg(test)]
mod tests {
    use super::{app_route, classify, LinkTarget};
    use tauri::Url;

    fn class(s: &str) -> LinkTarget {
        classify(&Url::parse(s).unwrap())
    }

    #[test]
    fn the_bundled_app_is_app_on_every_platform() {
        assert_eq!(class("tauri://localhost/dashboard/inbox"), LinkTarget::App);
        assert_eq!(class("http://tauri.localhost/compose"), LinkTarget::App);
        assert_eq!(class("https://tauri.localhost/"), LinkTarget::App);
    }

    #[test]
    fn web_pages_and_phone_numbers_leave_the_app() {
        assert_eq!(class("https://owlat.app/docs"), LinkTarget::External);
        assert_eq!(
            class("http://example.com/unsubscribe?u=1"),
            LinkTarget::External
        );
        assert_eq!(class("tel:+49301234567"), LinkTarget::External);
        // A look-alike host is not the app.
        assert_eq!(
            class("https://tauri.localhost.example.com/"),
            LinkTarget::External
        );
    }

    #[test]
    fn localhost_is_the_app_only_in_debug_builds() {
        let expected = if cfg!(debug_assertions) {
            LinkTarget::App
        } else {
            LinkTarget::External
        };
        assert_eq!(class("http://localhost:3000/dashboard"), expected);
    }

    #[test]
    fn mailto_goes_to_compose_and_frame_documents_stay() {
        assert_eq!(class("mailto:ada@example.com?subject=Hi"), LinkTarget::Mail);
        assert_eq!(class("about:srcdoc"), LinkTarget::Internal);
        assert_eq!(class("blob:tauri://localhost/5c1d"), LinkTarget::Internal);
        assert_eq!(class("data:text/plain,hi"), LinkTarget::Internal);
    }

    #[test]
    fn unknown_schemes_are_refused() {
        assert_eq!(class("file:///etc/passwd"), LinkTarget::Unknown);
        assert_eq!(class("javascript:alert(1)"), LinkTarget::Unknown);
        assert_eq!(class("owlat://thread/1"), LinkTarget::Unknown);
    }

    #[test]
    fn app_route_keeps_query_and_fragment() {
        let url =
            Url::parse("tauri://localhost/dashboard/campaigns/1/email?from=edit#top").unwrap();
        assert_eq!(
            app_route(&url),
            "/dashboard/campaigns/1/email?from=edit#top"
        );
        let bare = Url::parse("http://tauri.localhost/compose").unwrap();
        assert_eq!(app_route(&bare), "/compose");
    }
}
