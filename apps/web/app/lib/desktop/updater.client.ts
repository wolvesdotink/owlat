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
 *   - the probe answers 200 with the default policy and nothing cached at all
 *     (a server upgraded minutes ago, or GitHub rate-limiting a fresh
 *     self-host) → GitHub, since the instance would offer GitHub's newest
 *     stable release anyway and that is what the app did before;
 *   - the probe answers 200 with anything else → that instance's manifest
 *     route, even when it has nothing to offer: a pin, a defer window or the
 *     pre-release channel is a constraint GitHub's endpoint cannot apply, and a
 *     paused policy is a decision in its own right;
 *   - anything else (offline, 500, timeout, a body that is not a policy) → skip
 *     this check and try again at the next trigger. Unreachable means "not
 *     now", never "go around it".
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
import { scheduleIdle } from '~/lib/scheduleIdle';
import type {
	DesktopUpdateErrorKind,
	DesktopUpdatePolicySummary,
} from '~/composables/useDesktopUpdateState';

/** Re-check every six hours while the app stays open (it can stay open for days). */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The automatic check on launch waits this long, then for an idle moment: the
 * policy probe, the manifest fetch and a possible download would otherwise
 * compete with the first Postbox load for the network and the main thread.
 */
export const FIRST_CHECK_DELAY_MS = 30_000;

/** How long the delayed first check may then wait for idle time. */
const FIRST_CHECK_IDLE_TIMEOUT_MS = 10_000;

/** The policy probe is a capability check, not a critical path — fail it fast. */
const POLICY_TIMEOUT_MS = 5_000;

export type UpdateSource =
	/** Use the endpoint compiled into the app (GitHub's latest release). */
	| { kind: 'github'; endpoint: null }
	| { kind: 'server'; endpoint: string; host: string; policy: DesktopUpdatePolicySummary }
	/** The instance should decide but could not be reached; do nothing this round. */
	| { kind: 'skip'; host: string };

const GITHUB: UpdateSource = { kind: 'github', endpoint: null };

const MODES: readonly unknown[] = ['latest', 'pinned', 'paused'];
const CHANNELS: readonly unknown[] = ['stable', 'prerelease'];

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isNumberOrNull(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The probe body, checked field by field before anything is decided from it. A
 * 200 that is not a policy (a proxy's error page, a half-deployed route) says
 * nothing about what the operator allows, so it is treated as unreachable.
 */
export function parsePolicySummary(body: unknown): DesktopUpdatePolicySummary | null {
	if (typeof body !== 'object' || body === null) return null;
	const raw = body as Partial<Record<keyof DesktopUpdatePolicySummary, unknown>>;
	const { mode, channel, deferHours, hasCachedReleases } = raw;
	const { pinnedVersion, requiredVersion, latestVersion, latestPublishedAt, checkedAt } = raw;
	if (!MODES.includes(mode) || !CHANNELS.includes(channel)) return null;
	if (typeof deferHours !== 'number' || !Number.isFinite(deferHours)) return null;
	if (!isStringOrNull(pinnedVersion) || !isStringOrNull(requiredVersion)) return null;
	if (!isStringOrNull(latestVersion)) return null;
	if (!isNumberOrNull(latestPublishedAt) || !isNumberOrNull(checkedAt)) return null;
	if (hasCachedReleases !== undefined && typeof hasCachedReleases !== 'boolean') return null;
	return {
		mode: mode as DesktopUpdatePolicySummary['mode'],
		channel: channel as DesktopUpdatePolicySummary['channel'],
		pinnedVersion,
		requiredVersion,
		deferHours,
		latestVersion,
		latestPublishedAt,
		...(hasCachedReleases === undefined ? {} : { hasCachedReleases }),
		checkedAt,
	};
}

/**
 * Whether an instance that has nothing to offer may be gone around. Only when
 * it has cached nothing at all and runs the default policy: newest release,
 * stable channel, no pin, no defer window. GitHub's latest release is then what
 * the instance itself would offer after its first refresh. Every other policy
 * is a choice GitHub's endpoint cannot carry out, so the instance answers, and
 * an instance that has releases but none eligible has already answered.
 * (`requiredVersion` is a floor, not a hold, so it does not count.) An instance
 * older than `hasCachedReleases` cannot tell the two empties apart; for the
 * default policy it keeps the old fallback.
 */
export function mayBypassInstance(policy: DesktopUpdatePolicySummary): boolean {
	return (
		policy.latestVersion === null &&
		policy.hasCachedReleases !== true &&
		policy.mode === 'latest' &&
		policy.channel === 'stable' &&
		policy.pinnedVersion === null &&
		policy.deferHours === 0
	);
}

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
		const policy = parsePolicySummary(await res.json());
		if (!policy) return { kind: 'skip', host };
		if (mayBypassInstance(policy)) return GITHUB;
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
 * Register update handling: a check shortly after boot (`FIRST_CHECK_DELAY_MS`,
 * then idle time), a re-check every six hours while the app stays open, and
 * the manual `owlat:check-updates` trigger (native menu / palette / device
 * page).
 *
 * The device setting gates the automatic side only — the boot check and every
 * tick of the timer, each of which reads the setting afresh — so "check for new
 * versions when the app starts" being switched off mid-session takes effect at
 * the next tick rather than at the next launch, and switching it on does too.
 * The manual trigger always runs.
 *
 * Idempotent: a second call stacks neither a listener nor a timer.
 */
export function setupUpdateChecks(options?: { firstCheckDelayMs?: number }): void {
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

	// The boot check leaves the launch alone: first the fixed delay, then an
	// idle moment. A manual check in the meantime runs at once, and the guards
	// in `runUpdateCheck` keep the two from overlapping.
	const firstCheckDelayMs = options?.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS;
	setTimeout(() => {
		scheduleIdle(() => {
			void main.then(async (ok) => {
				if (ok && (await autoChecksEnabled())) void runUpdateCheck();
			});
		}, FIRST_CHECK_IDLE_TIMEOUT_MS);
	}, firstCheckDelayMs);

	void (async () => {
		if (!(await main)) return;
		// A workspace switch reloads the webview, so the timer re-binds to
		// whatever workspace is active then; there is nothing to re-arm here.
		timerId ??= setInterval(() => {
			void scheduledCheck();
		}, UPDATE_CHECK_INTERVAL_MS);
	})();
}
