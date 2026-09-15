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
 *   - the probe answers 200 → that instance's manifest route;
 *   - anything else (offline, 500, timeout) → skip this check and try again at
 *     the next trigger. Unreachable means "not now", never "go around it".
 *
 * Progress and failures land in `useDesktopUpdateState` for the Updates card;
 * the OS notification stays, and now carries a "Restart now" action where the
 * platform can render one.
 */
import { getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { useDesktopUpdateState } from '~/composables/useDesktopUpdateState';
import type { DesktopUpdatePolicySummary } from '~/composables/useDesktopUpdateState';

/** Re-check every six hours while the app stays open (it can stay open for days). */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The policy probe is a capability check, not a critical path — fail it fast. */
const POLICY_TIMEOUT_MS = 5_000;

export type UpdateSource =
	/** Use the endpoint compiled into the app (GitHub's latest release). */
	| { kind: 'github'; endpoint: null }
	| { kind: 'server'; endpoint: string; host: string; policy: DesktopUpdatePolicySummary }
	/** The instance should decide but could not be reached; do nothing this round. */
	| { kind: 'skip' };

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

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);
	try {
		const res = await fetch(`${origin}/api/desktop/update-policy`, {
			credentials: 'omit',
			signal: controller.signal,
		});
		// No such route: an instance from before server-managed updates.
		if (res.status === 404) return GITHUB;
		if (!res.ok) return { kind: 'skip' };
		const policy = (await res.json()) as DesktopUpdatePolicySummary;
		const { buildUpdateEndpoint } = await import('@owlat/desktop/src/updater');
		return {
			kind: 'server',
			endpoint: buildUpdateEndpoint(origin),
			host: new URL(origin).host,
			policy,
		};
	} catch {
		return { kind: 'skip' };
	} finally {
		clearTimeout(timer);
	}
}

/** Relaunch into the downloaded version (the card's "Restart to update"). */
export async function restartToUpdate(): Promise<void> {
	const { restartApp } = await import('@owlat/desktop/src/updater');
	await restartApp();
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

async function notify(title: string, body: string): Promise<void> {
	const { sendDesktopNotification } = await import('@owlat/desktop/src/notifications');
	await sendDesktopNotification(title, body);
}

/**
 * One full round: resolve the source, check, download, offer the restart.
 * `announce` (the manual trigger) also notifies when there was nothing to do.
 */
export async function runUpdateCheck(opts?: { announce?: boolean }): Promise<void> {
	const state = useDesktopUpdateState();
	// A timer tick must not interrupt a download, nor stack a second check on a
	// manual one.
	if (state.phase.value === 'checking' || state.phase.value === 'downloading') return;

	const source = await resolveUpdateSource();
	if (source.kind === 'skip') return;
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
		await announceReady(found.version).catch(() => {});
	} catch (e) {
		const kind = (e as { error?: unknown })?.error;
		state.markFailed(
			kind === 'network' || kind === 'signature' || kind === 'unknown' ? kind : 'unknown'
		);
		console.warn('[desktop] Update check failed:', e);
	}
}

let wired = false;
let timerId: ReturnType<typeof setInterval> | null = null;

/**
 * Register update handling: a check on boot, a re-check every six hours while
 * the app stays open, and the manual `owlat:check-updates` trigger (native menu
 * / palette / device page).
 *
 * The device setting gates the automatic side only — both the boot check and
 * the timer — so "check for new versions when the app starts" being off cannot
 * be undone by leaving the app open overnight. The manual trigger always runs.
 *
 * Idempotent: a second call stacks neither a listener nor a timer.
 */
export function setupUpdateChecks(): void {
	if (wired) return;
	wired = true;

	if (typeof window !== 'undefined') {
		window.addEventListener('owlat:check-updates', () => void runUpdateCheck({ announce: true }));
	}

	void (async () => {
		try {
			const { loadDesktopAppSettings } = await import('~/composables/useDesktopAppSettings');
			const settings = await loadDesktopAppSettings();
			if (!settings.global.autoCheckUpdates) return;
		} catch {
			// Settings unreadable — default to checking.
		}
		void runUpdateCheck();
		// A workspace switch reloads the webview, so the timer re-binds to
		// whatever workspace is active then; there is nothing to re-arm here.
		timerId ??= setInterval(() => void runUpdateCheck(), UPDATE_CHECK_INTERVAL_MS);
	})();
}
