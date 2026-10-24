/**
 * Notice when the server runs a newer Owlat than this tab.
 *
 * The app is an `ssr: false` SPA: a tab renders one document and keeps the
 * code it booted with for as long as it stays open, while each release ships
 * new code (and drops the old lazy chunks). The tab compares the build it
 * booted with (Nuxt's build id, baked into the document) against the build the
 * server answers `/api/app-version` with. Once they differ:
 *
 *  - `update` holds the deployed build, and the banner offers Reload and the
 *    release's notes;
 *  - the next change of page reloads the tab instead, at its destination,
 *    when nothing would be lost at that moment (`reloadSafety.ts`) and the
 *    destination is still the one last asked for (`navigationRequests.ts`).
 *    The decision never waits; a draft still on its way to the device leaves
 *    the reload to a later change of page.
 *
 * A reload the server answered with the old build again (a cache, a deploy
 * still rolling out) is remembered for the session, so the tab never loops on
 * it; the banner stays and a Reload press still works.
 *
 * Checks run every {@link CHECK_INTERVAL_MS} while the tab is visible, and
 * when the person comes back to it or the network returns; whatever asks,
 * two requests are at least {@link MIN_CHECK_GAP_MS} apart. A failed,
 * malformed or matching answer changes nothing.
 */
import { shallowRef, type ShallowRef } from 'vue';
import type { Router } from 'vue-router';
import { OWLAT_REPO_URL } from '~/utils/releaseNotes';
import { trackNavigationRequests } from './navigationRequests';

export const CHECK_INTERVAL_MS = 10 * 60_000;
export const MIN_CHECK_GAP_MS = 60_000;

/** Session-storage key: the build id the last update reload was for. */
export const UPDATE_RELOAD_KEY = 'owlat:app-update-reload';

/** Build ids that name no deployed build: development and test runs. */
const UNVERSIONED_BUILD_IDS = new Set(['dev', 'test']);
const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface DeployedBuild {
	buildId: string;
	/** The release version, when the deployment is a tagged release. */
	version: string | null;
}

/** A build id two builds can be told apart by. */
export function isComparableBuildId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 128 &&
		!UNVERSIONED_BUILD_IDS.has(value)
	);
}

/** The `/api/app-version` answer, or null when it is not one. */
export function parseDeployedBuild(value: unknown): DeployedBuild | null {
	if (typeof value !== 'object' || value === null) return null;
	const { buildId, version } = value as Record<string, unknown>;
	if (!isComparableBuildId(buildId)) return null;
	return {
		buildId,
		version: typeof version === 'string' && RELEASE_VERSION.test(version) ? version : null,
	};
}

/** The release page for `version`, or null for a build that is not a release. */
export function releaseNotesUrl(version: string | null): string | null {
	if (!version) return null;
	return `${OWLAT_REPO_URL}/releases/tag/v${version.replace(/^v/, '')}`;
}

function readMark(storage: Storage | null): string | null {
	try {
		return storage?.getItem(UPDATE_RELOAD_KEY) ?? null;
	} catch {
		return null;
	}
}

function writeMark(storage: Storage | null, buildId: string | null): void {
	try {
		if (buildId === null) storage?.removeItem(UPDATE_RELOAD_KEY);
		else storage?.setItem(UPDATE_RELOAD_KEY, buildId);
	} catch {
		// Private mode or a full quota: the loop guard is lost, the reload still works.
	}
}

export interface AppVersionWatchDeps {
	/** The build this tab booted with. */
	bootBuildId: string;
	/** The deployed build's answer: the parsed JSON body, or anything when it failed. */
	fetchDeployed: () => Promise<unknown>;
	router: Pick<
		Router,
		'beforeEach' | 'resolve' | 'push' | 'replace' | 'go' | 'back' | 'forward' | 'options'
	>;
	/** Let pending device writes land, then answer whether a reload loses nothing. */
	settleForReload: () => Promise<boolean>;
	/** Whether a reload right now loses nothing, without waiting for anything. */
	canReloadNow: () => boolean;
	/** Load `href` as a new document. */
	assign: (href: string) => void;
	/** Reload the current document. */
	reload: () => void;
	/** Survives the reload; null where storage is unavailable. */
	storage: Storage | null;
	isVisible: () => boolean;
	now?: () => number;
}

export type ReloadOutcome = 'reloading' | 'blocked' | 'idle';

export interface AppVersionWatch {
	/** The deployed build, once it differs from the one this tab runs. */
	update: Readonly<ShallowRef<DeployedBuild | null>>;
	/**
	 * Ask the server now, unless a check is running, an update is known or
	 * the last check started less than {@link MIN_CHECK_GAP_MS} ago.
	 */
	check: () => Promise<void>;
	/** Start the checks and the reload-on-navigation guard. Returns the stop. */
	start: () => () => void;
	/**
	 * The banner's Reload: once nothing would be lost, reload the page.
	 * `blocked` leaves the page as it is.
	 */
	reloadNow: () => Promise<ReloadOutcome>;
}

export function createAppVersionWatch(deps: AppVersionWatchDeps): AppVersionWatch {
	const now = deps.now ?? Date.now;
	const update = shallowRef<DeployedBuild | null>(null);
	let inFlight = false;
	let lastCheckAt = Number.NEGATIVE_INFINITY;
	let reloading = false;

	// The previous page load was an update reload. Landing on another build
	// than the one it was for means the server still answered with the old
	// one: no further reload of its own for that build in this session.
	const mark = readMark(deps.storage);
	const missedBuildId = mark !== null && mark !== deps.bootBuildId ? mark : null;
	if (mark === deps.bootBuildId) writeMark(deps.storage, null);

	async function check(): Promise<void> {
		if (inFlight || update.value || now() - lastCheckAt < MIN_CHECK_GAP_MS) return;
		inFlight = true;
		lastCheckAt = now();
		try {
			const deployed = parseDeployedBuild(await deps.fetchDeployed());
			if (deployed && deployed.buildId !== deps.bootBuildId) update.value = deployed;
		} catch {
			// Offline or a server mid-restart: ask again next time.
		} finally {
			inFlight = false;
		}
	}

	function leave(target: string | null): void {
		const deployed = update.value;
		if (!deployed || reloading) return;
		reloading = true;
		writeMark(deps.storage, deployed.buildId);
		if (target === null) deps.reload();
		else deps.assign(target);
	}

	async function reloadNow(): Promise<ReloadOutcome> {
		if (!update.value || reloading) return 'idle';
		if (!(await deps.settleForReload())) return 'blocked';
		leave(null);
		return 'reloading';
	}

	function start(): () => void {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			timer = setTimeout(() => {
				timer = undefined;
				if (update.value) return;
				if (deps.isVisible()) void check();
				schedule();
			}, CHECK_INTERVAL_MS);
		};
		const onReturn = () => {
			if (deps.isVisible()) void check();
		};
		schedule();
		document.addEventListener('visibilitychange', onReturn);
		window.addEventListener('online', onReturn);

		// A global before-guard: the leave guards of the page being left have
		// already run (a page with unsaved edits has asked about them), and the
		// destination's code has not been fetched yet, which after a deploy may
		// be a chunk the server no longer has. The router lets a newer request
		// replace a navigation still in its guards and notices only after all
		// global guards ran, while an earlier one (Nuxt's route middleware) may
		// have awaited. So the reload goes only to the destination last asked
		// for, and the guard itself never awaits, leaving no gap for a request
		// between that check and the reload.
		const requests = trackNavigationRequests(deps.router);
		const removeGuard = deps.router.beforeEach((to, from) => {
			const deployed = update.value;
			if (!deployed || reloading || deployed.buildId === missedBuildId) return;
			// Query and hash changes (a filter, a tab within the page) stay in place.
			if (to.path === from.path) return;
			if (!requests.isLatest(to)) return;
			if (!deps.canReloadNow()) return;
			leave(deps.router.resolve(to).href);
			return false;
		});

		return () => {
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onReturn);
			window.removeEventListener('online', onReturn);
			removeGuard();
			requests.stop();
		};
	}

	return { update, check, start, reloadNow };
}
