import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceConfig } from '../workspaceTypes';

// The module under test talks to three seams: the active workspace (which
// instance to ask), the desktop bridge (the Rust updater commands) and the
// device settings (is the boot check on). Stub all three; the Tauri bridge in
// particular must never be the real one under vitest.
const getActiveWorkspace = vi.fn<() => WorkspaceConfig | null>(() => null);
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	getActiveWorkspace: () => getActiveWorkspace(),
	isDesktopRuntime: () => true,
}));

const checkForUpdate = vi.fn(async (_endpoint: string | null) => null as UpdateFound | null);
const installUpdate = vi.fn(async (_onProgress: (event: ProgressEvent_) => void) => {});
const notifyUpdateReady = vi.fn(async () => true);
const onUpdateRestartRequest = vi.fn(async () => null);
const restartApp = vi.fn(async () => {});
vi.mock('@owlat/desktop/src/updater', () => ({
	buildUpdateEndpoint: (siteUrl: string) =>
		`${new URL(siteUrl).origin}/api/desktop/update/{{target}}/{{arch}}/{{current_version}}`,
	checkForUpdate: (endpoint: string | null) => checkForUpdate(endpoint),
	installUpdate: (onProgress: (event: ProgressEvent_) => void) => installUpdate(onProgress),
	notifyUpdateReady: () => notifyUpdateReady(),
	onUpdateRestartRequest: () => onUpdateRestartRequest(),
	restartApp: () => restartApp(),
}));

const sendDesktopNotification = vi.fn(async () => {});
vi.mock('@owlat/desktop/src/notifications', () => ({
	sendDesktopNotification: (...args: unknown[]) => sendDesktopNotification(...(args as [])),
}));

const loadDesktopAppSettings = vi.fn(async () => ({ global: { autoCheckUpdates: true } }));
vi.mock('~/composables/useDesktopAppSettings', () => ({
	loadDesktopAppSettings: () => loadDesktopAppSettings(),
}));

type UpdateFound = { version: string; notes?: string };
type ProgressEvent_ =
	| { kind: 'started'; contentLength?: number }
	| { kind: 'progress'; chunkLength: number }
	| { kind: 'finished' };

const POLICY = {
	mode: 'latest',
	channel: 'stable',
	pinnedVersion: null,
	requiredVersion: null,
	deferHours: 0,
	latestVersion: '0.4.7',
	latestPublishedAt: 1,
	checkedAt: 2,
};

function workspace(siteUrl: string): WorkspaceConfig {
	return {
		id: 'ws-1',
		label: 'Acme',
		siteUrl,
		convexUrl: 'https://acme.convex.cloud',
		convexSiteUrl: 'https://acme.convex.site',
		userId: 'u1',
		tokenRef: 'owlat-ws:ws-1',
		addedAt: 0,
		lastActiveAt: 0,
		accentColor: '#c4785a',
	};
}

const fetchMock = vi.fn();

/**
 * Fresh module graph per case: both the update run and the state store it
 * writes to are module-level singletons, so they have to be re-imported
 * together or a phase from a previous case leaks into the next.
 */
async function load() {
	vi.resetModules();
	const client = await import('../updater.client');
	const { useDesktopUpdateState } = await import('~/composables/useDesktopUpdateState');
	return { ...client, state: useDesktopUpdateState() };
}

beforeEach(() => {
	getActiveWorkspace.mockReturnValue(null);
	checkForUpdate.mockReset().mockResolvedValue(null);
	installUpdate.mockReset().mockResolvedValue(undefined);
	notifyUpdateReady.mockClear();
	sendDesktopNotification.mockClear();
	loadDesktopAppSettings.mockClear().mockResolvedValue({ global: { autoCheckUpdates: true } });
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('useNuxtApp', () => ({ $i18n: { t: (key: string) => key } }));
});

// No `unstubAllGlobals` teardown here: the shared setup file installs the Nuxt
// auto-import shims (`ref`, `computed`, …) the same way, and clearing them
// leaves the state composable unable to build its refs.

function policyResponse(status: number, body: unknown = POLICY) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('resolveUpdateSource', () => {
	it('uses GitHub when no workspace is connected yet (welcome screen)', async () => {
		const { resolveUpdateSource } = await load();
		await expect(resolveUpdateSource()).resolves.toEqual({ kind: 'github', endpoint: null });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('uses GitHub for a plain-http workspace (tauri dev), without probing it', async () => {
		getActiveWorkspace.mockReturnValue(workspace('http://localhost:3000'));
		const { resolveUpdateSource } = await load();

		// The updater refuses non-https endpoints, so asking would be pointless.
		await expect(resolveUpdateSource()).resolves.toEqual({ kind: 'github', endpoint: null });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('points at the instance when the policy probe answers', async () => {
		getActiveWorkspace.mockReturnValue(workspace('https://acme.example/dashboard'));
		fetchMock.mockResolvedValue(policyResponse(200));
		const { resolveUpdateSource } = await load();

		await expect(resolveUpdateSource()).resolves.toEqual({
			kind: 'server',
			endpoint: 'https://acme.example/api/desktop/update/{{target}}/{{arch}}/{{current_version}}',
			host: 'acme.example',
			policy: POLICY,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://acme.example/api/desktop/update-policy',
			expect.objectContaining({ credentials: 'omit' })
		);
	});

	it('falls back to GitHub when the instance predates the route (404)', async () => {
		getActiveWorkspace.mockReturnValue(workspace('https://old.example'));
		fetchMock.mockResolvedValue(policyResponse(404, null));
		const { resolveUpdateSource } = await load();

		await expect(resolveUpdateSource()).resolves.toEqual({ kind: 'github', endpoint: null });
	});

	it('skips the round when the instance is reachable but broken (500)', async () => {
		getActiveWorkspace.mockReturnValue(workspace('https://acme.example'));
		fetchMock.mockResolvedValue(policyResponse(500, null));
		const { resolveUpdateSource } = await load();

		// Deliberately NOT GitHub: an instance that manages updates and is having
		// a bad minute must not be gone around.
		await expect(resolveUpdateSource()).resolves.toEqual({ kind: 'skip' });
	});

	it('skips the round when the probe never lands (offline / timeout)', async () => {
		getActiveWorkspace.mockReturnValue(workspace('https://acme.example'));
		fetchMock.mockRejectedValue(new Error('network down'));
		const { resolveUpdateSource } = await load();

		await expect(resolveUpdateSource()).resolves.toEqual({ kind: 'skip' });
	});
});

describe('runUpdateCheck', () => {
	it('records "up to date" and notifies only when asked to announce', async () => {
		const { runUpdateCheck, state } = await load();

		await runUpdateCheck();
		expect(state.phase.value).toBe('upToDate');
		expect(state.lastCheckedAt.value).not.toBeNull();
		expect(sendDesktopNotification).not.toHaveBeenCalled();

		await runUpdateCheck({ announce: true });
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1);
	});

	it('walks checking → downloading → ready, folding progress into the counters', async () => {
		const { runUpdateCheck, state } = await load();
		// Phases observed from inside the two steps, in order.
		const seen: string[] = [];
		checkForUpdate.mockImplementation(async () => {
			seen.push(state.phase.value);
			return { version: '0.4.7', notes: 'Fixes' };
		});
		installUpdate.mockImplementation(async (onProgress) => {
			seen.push(state.phase.value);
			onProgress({ kind: 'started', contentLength: 1024 * 1024 });
			onProgress({ kind: 'progress', chunkLength: 256 * 1024 });
			onProgress({ kind: 'progress', chunkLength: 256 * 1024 });
			onProgress({ kind: 'finished' });
		});

		await runUpdateCheck();

		expect(seen).toEqual(['checking', 'downloading']);
		expect(state.phase.value).toBe('ready');
		expect(state.version.value).toBe('0.4.7');
		expect(state.notes.value).toBe('Fixes');
		expect(state.totalBytes.value).toBe(1024 * 1024);
		expect(state.downloadedBytes.value).toBe(1024 * 1024);
		expect(state.percent.value).toBe(100);
		// The "update ready" toast carries the restart action.
		expect(notifyUpdateReady).toHaveBeenCalledTimes(1);
	});

	it('keeps the typed failure kind instead of swallowing it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		checkForUpdate.mockRejectedValue(Object.assign(new Error('down'), { error: 'network' }));
		const { runUpdateCheck, state } = await load();

		await runUpdateCheck();

		expect(state.phase.value).toBe('error');
		expect(state.errorKind.value).toBe('network');
		warn.mockRestore();
	});

	it('leaves the state alone when the source says skip', async () => {
		getActiveWorkspace.mockReturnValue(workspace('https://acme.example'));
		fetchMock.mockRejectedValue(new Error('offline'));
		const { runUpdateCheck, state } = await load();

		await runUpdateCheck();

		expect(state.phase.value).toBe('idle');
		expect(checkForUpdate).not.toHaveBeenCalled();
	});

	it('does not stack a second run on top of a download in flight', async () => {
		checkForUpdate.mockResolvedValue({ version: '0.4.7' });
		let release: (() => void) | undefined;
		installUpdate.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const { runUpdateCheck, state } = await load();

		const first = runUpdateCheck();
		await vi.waitFor(() => expect(state.phase.value).toBe('downloading'));
		await runUpdateCheck();
		expect(checkForUpdate).toHaveBeenCalledTimes(1);

		release?.();
		await first;
	});

	it('records which instance chose the update, for the device card', async () => {
		getActiveWorkspace.mockReturnValue(workspace('https://acme.example'));
		fetchMock.mockResolvedValue(policyResponse(200));
		const { runUpdateCheck, state } = await load();

		await runUpdateCheck();

		expect(state.source.value).toEqual({ kind: 'server', host: 'acme.example', policy: POLICY });
		expect(checkForUpdate).toHaveBeenCalledWith(
			'https://acme.example/api/desktop/update/{{target}}/{{arch}}/{{current_version}}'
		);
	});
});

describe('setupUpdateChecks', () => {
	it('arms the six-hour timer once, however often it is called', async () => {
		const setInterval_ = vi.spyOn(globalThis, 'setInterval');
		const { setupUpdateChecks, UPDATE_CHECK_INTERVAL_MS } = await load();

		setupUpdateChecks();
		setupUpdateChecks();
		await vi.waitFor(() => expect(setInterval_).toHaveBeenCalledTimes(1));

		expect(setInterval_).toHaveBeenCalledWith(expect.any(Function), UPDATE_CHECK_INTERVAL_MS);
		expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
		clearInterval(setInterval_.mock.results[0]?.value as ReturnType<typeof setInterval>);
		setInterval_.mockRestore();
	});

	it('honours the device setting: no boot check and no timer when it is off', async () => {
		loadDesktopAppSettings.mockResolvedValue({ global: { autoCheckUpdates: false } });
		const setInterval_ = vi.spyOn(globalThis, 'setInterval');
		const { setupUpdateChecks } = await load();

		setupUpdateChecks();
		await vi.waitFor(() => expect(loadDesktopAppSettings).toHaveBeenCalled());

		expect(checkForUpdate).not.toHaveBeenCalled();
		expect(setInterval_).not.toHaveBeenCalled();
		setInterval_.mockRestore();
	});

	it('still runs a manual check when auto-checks are off', async () => {
		loadDesktopAppSettings.mockResolvedValue({ global: { autoCheckUpdates: false } });
		const { setupUpdateChecks } = await load();
		setupUpdateChecks();

		// Counted as a delta: earlier cases in this file left their own listeners
		// on the shared window, and a DOM listener outlives `vi.resetModules()`.
		const before = checkForUpdate.mock.calls.length;
		window.dispatchEvent(new Event('owlat:check-updates'));

		await vi.waitFor(() => expect(checkForUpdate.mock.calls.length).toBeGreaterThan(before));
	});
});
