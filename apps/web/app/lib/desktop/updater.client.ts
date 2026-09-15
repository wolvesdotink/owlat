/**
 * Desktop auto-update run: ask the active workspace which version to install,
 * download it, and offer a restart.
 *
 * Runs in the actual webview, from the boot plugin and from the
 * `owlat:check-updates` window event (native menu / palette / device page).
 * The decision of WHAT to install belongs to the instance the app is connected
 * to; this module only decides WHO to ask:
 *
 *   - no active workspace, or a workspace whose `siteUrl` is not https (`tauri
 *     dev` against localhost) → GitHub, exactly as before;
 *   - the policy probe answers 404 → GitHub (an instance older than the route);
 *   - the probe answers 200 but the instance has no release cached yet (a
 *     server upgraded minutes ago, or GitHub rate-limiting a fresh self-host)
 *     → GitHub, since the instance has nothing to offer and that is what the
 *     app did before; a paused policy is still respected;
 *   - the probe answers 200 with a release → that instance's manifest route;
 *   - anything else (offline, 500, timeout) → skip this check and try again at
 *     the next trigger. Unreachable means "not now", never "go around it".
 *
 * Only the main window runs any of this. The compose window boots the same SPA
 * but shares the one native update slot, so a second webview checking and
 * downloading on its own would race the first.
 *
 * Progress and failures land in `useDesktopUpdateState` for the Updates card;
 * the OS notification stays, and now carries a "Restart now" action where the
 * platform can render one.
 */
import { getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { useDesktopUpdateState } from '~/composables/useDesktopUpdateState';
import type {
	DesktopUpdateErrorKind,
	DesktopUpdatePolicySummary,
} from '~/composables/useDesktopUpdateState';

/** Re-check every six hours while the app stays open (it can stay open for days). */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The policy probe is a capability check, not a critical path — fail it fast. */
const POLICY_TIMEOUT_MS = 5_000;

export type UpdateSource =
	/** Use the endpoint compiled into the app (GitHub's latest release). */
	| { kind: 'github'; endpoint: null }
	| { kind: 'server'; endpoint: string; host: string; policy: DesktopUpdatePolicySummary }
	/** The instance should decide but could not be reached; do nothing this round. */
	| { kind: 'skip'; host: string };

const GITHUB: UpdateSource = { kind: 'github', endpoint: null };

/**
 * Decide which endpoint this check should use. Exported for its own test: the
 * fallback rules are the whole compatibility story between a new app and an
 * instance of any age.
 */
export async function resolveUpdateSource(): Promise<UpdateSource> {
	const workspace = getActiveWorkspace();
	if (!workspace) return GITHUB;

	let origin: string;
	try {
		const url = new URL(workspace.siteUrl);
		// The updater refuses non-https endpoints (and `dangerousInsecure-
		// TransportProtocol` stays off), so an http workspace never gets asked.
		if (url.protocol !== 'https:') return GITHUB;
		origin = url.origin;
	} catch {
		return GITHUB;
	}
	const host = new URL(origin).host;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);
	try {
		const res = await fetch(`${origin}/api/desktop/update-policy`, {
			credentials: 'omit',
			signal: controller.signal,
		});
		// No such route: an instance from before server-managed updates.
		if (res.status === 404) return GITHUB;
		if (!res.ok) return { kind: 'skip', host };
		const policy = (await res.json()) as DesktopUpdatePolicySummary;
		// An instance that manages updates but has nothing cached would answer
		// 204 to everyone and the app would call itself up to date. The instance
		// cannot offer anything, so GitHub decides — unless the operator paused
		// updates, which is a decision in its own right.
		if (policy.latestVersion === null && policy.mode !== 'paused') return GITHUB;
		const { buildUpdateEndpoint } = await import('@owlat/desktop/src/updater');
		return { kind: 'server', endpoint: buildUpdateEndpoint(origin), host, policy };
	} catch {
		return { kind: 'skip', host };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Relaunch into the downloaded version (the card's "Restart to update", and
 * the notification's action). On macOS and Linux this installs the verified
 * bytes and restarts; on Windows it hands over to the installer, which
 * relaunches the app itself. A failed install is reported on the card rather
 * than thrown at a button.
 */
export async function restartToUpdate(): Promise<void> {
	try {
		const { restartApp } = await import('@owlat/desktop/src/updater');
		await restartApp();
	} catch (e) {
		useDesktopUpdateState().markFailed(errorKindOf(e));
		console.warn('[desktop] Restart to update failed:', e);
	}
}

function errorKindOf(e: unknown): DesktopUpdateErrorKind {
	const kind = (e as { error?: unknown })?.error;
	return kind === 'network' || kind === 'signature' || kind === 'unknown' ? kind : 'unknown';
}

let restartListenerBound = false;

/**
 * Announce a downloaded update. The notification is written by the OS, not by a
 * component, so the translator comes off the Nuxt app (`$i18n`) rather than
 * `useI18n()` — this runs from a plugin and from a `window` event listener,
 * neither of which is a setup scope.
 */
async function announceReady(version: string): Promise<void> {
	const { t } = useNuxtApp().$i18n;
	const title = t('shared.desktop.updater.updateReady.title');
	const body = t('shared.desktop.updater.updateReady.body', { version })
		.replace(/\s+/g, ' ')
		.trim();
	const { notifyUpdateReady, onUpdateRestartRequest } = await import('@owlat/desktop/src/updater');
	// Bound once, and only once an update is actually ready: the event only ever
	// fires from a notification we just raised.
	if (!restartListenerBound) {
		restartListenerBound = true;
		void onUpdateRestartRequest(() => void restartToUpdate());
	}
	const shown = await notifyUpdateReady(title, body, t('desktop.settings.updates.restartNow'));
	// An app shell older than the command still gets to say something.
	if (!shown) await notify(title, body);
}

async function announceUpToDate(): Promise<void> {
	const { t } = useNuxtApp().$i18n;
	await notify(
		t('shared.desktop.updater.upToDate.title'),
		t('shared.desktop.updater.upToDate.body')
	);
}

async function announceUnreachable(host: string): Promise<void> {
	const { t } = useNuxtApp().$i18n;
	await notify(
		t('shared.desktop.updater.unreachable.title'),
		t('shared.desktop.updater.unreachable.body', { host })
	);
}

async function notify(title: string, body: string): Promise<void> {
	const { sendDesktopNotification } = await import('@owlat/desktop/src/notifications');
	await sendDesktopNotification(title, body);
}

/**
 * One full round: resolve the source, check, download, offer the restart.
 * `announce` (the manual trigger) also notifies when there was nothing to do,
 * and when the instance could not be asked.
 */
export async function runUpdateCheck(opts?: { announce?: boolean }): Promise<void> {
	const state = useDesktopUpdateState();
	// A timer tick must not interrupt a download, nor stack a second check on a
	// manual one.
	if (state.phase.value === 'checking' || state.phase.value === 'downloading') return;
	// Downloaded and waiting for the restart. The running binary still reports
	// the old version, so a fresh check would be offered the same release and
	// fetch it all over again; a manual trigger just gets reminded instead.
	if (state.phase.value === 'ready') {
		if (opts?.announce && state.version.value) {
			await announceReady(state.version.value).catch(() => {});
		}
		return;
	}

	const source = await resolveUpdateSource();
	if (source.kind === 'skip') {
		// The automatic cadence stays quiet — an offline laptop is not news. A
		// person who clicked "Check now" gets told the check did not happen.
		if (opts?.announce) {
			state.markFailed('unreachable');
			await announceUnreachable(source.host).catch(() => {});
		}
		return;
	}
	state.setSource(
		source.kind === 'server'
			? { kind: 'server', host: source.host, policy: source.policy }
			: { kind: 'github' }
	);
	state.markChecking();

	try {
		const { checkForUpdate, installUpdate } = await import('@owlat/desktop/src/updater');
		const found = await checkForUpdate(source.endpoint);
		if (!found) {
			state.markUpToDate();
			if (opts?.announce) await announceUpToDate().catch(() => {});
			return;
		}
		// Auto-download: the bytes land in the background and the only thing left
		// to ask the user for is the restart.
		state.markDownloading(found.version, found.notes);
		await installUpdate((event) => state.applyProgress(event));
		state.markReady(found.version);
		// Nothing more to learn until the restart; the six-hour tick would only
		// bounce off the guard above.
		stopTimer();
		await announceReady(found.version).catch(() => {});
	} catch (e) {
		state.markFailed(errorKindOf(e));
		console.warn('[desktop] Update check failed:', e);
	}
}

let wired = false;
let timerId: ReturnType<typeof setInterval> | null = null;

function stopTimer(): void {
	if (timerId !== null) clearInterval(timerId);
	timerId = null;
}

/**
 * Whether this webview is the main window. The compose window boots the same
 * plugin; it must not run its own check against the shared native update slot.
 * Without a window API (a plain browser) there is only one window.
 */
async function isMainWindow(): Promise<boolean> {
	try {
		const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
		return getCurrentWebviewWindow().label === 'main';
	} catch {
		return true;
	}
}

/** The device setting, read fresh each time so a change mid-session counts. */
async function autoChecksEnabled(): Promise<boolean> {
	try {
		const { loadDesktopAppSettings } = await import('~/composables/useDesktopAppSettings');
		return (await loadDesktopAppSettings()).global.autoCheckUpdates;
	} catch {
		// Settings unreadable — default to checking.
		return true;
	}
}

async function scheduledCheck(): Promise<void> {
	if (await autoChecksEnabled()) await runUpdateCheck();
}

/**
 * Register update handling: a check on boot, a re-check every six hours while
 * the app stays open, and the manual `owlat:check-updates` trigger (native menu
 * / palette / device page).
 *
 * The device setting gates the automatic side only — the boot check and every
 * tick of the timer, each of which reads the setting afresh — so "check for new
 * versions when the app starts" being switched off mid-session takes effect at
 * the next tick rather than at the next launch, and switching it on does too.
 * The manual trigger always runs.
 *
 * Idempotent: a second call stacks neither a listener nor a timer.
 */
export function setupUpdateChecks(): void {
	if (wired) return;
	wired = true;

	const main = isMainWindow();
	if (typeof window !== 'undefined') {
		window.addEventListener('owlat:check-updates', () => {
			void main.then((ok) => {
				if (ok) void runUpdateCheck({ announce: true });
			});
		});
	}

	void (async () => {
		if (!(await main)) return;
		if (await autoChecksEnabled()) void runUpdateCheck();
		// A workspace switch reloads the webview, so the timer re-binds to
		// whatever workspace is active then; there is nothing to re-arm here.
		timerId ??= setInterval(() => {
			void scheduledCheck();
		}, UPDATE_CHECK_INTERVAL_MS);
	})();
}
