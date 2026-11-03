/**
 * Starting a provider's authorization-code flow (Google or Microsoft).
 *
 * Two things can silently strand a user here: a `returnTo` that is not a
 * same-site path (the backend rejects it, and the connect never starts), and
 * the desktop app navigating its own webview to the provider's consent screen — a
 * Tauri window has no address bar and no way back, so the consent screen has to
 * go to the SYSTEM browser. Both are pinned below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

const i18n = createTestI18n();
vi.stubGlobal('useI18n', () => i18n.global);

// `api` is a bottomless Proxy: the composable only needs a function reference
// to hand the operation module, and the stub below never looks at it.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

const isDesktopRuntime = vi.fn(() => false);
vi.mock('~/lib/desktop/activeWorkspace', () => ({ isDesktopRuntime: () => isDesktopRuntime() }));

const openExternal = vi.fn(async () => {});
vi.mock('@owlat/desktop/src/shell', () => ({ openExternal: (url: string) => openExternal(url) }));

import { returnToWithOAuthFlag, useMailOAuthConnect } from '../useMailOAuthConnect';

const assign = vi.fn();
let run: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	isDesktopRuntime.mockReturnValue(false);
	run = vi.fn(async () => ({
		ok: true,
		result: { authorizationUrl: 'https://accounts.google/x' },
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
	// happy-dom's `location` is not configurable as a whole; the one method the
	// composable calls is.
	vi.spyOn(window.location, 'assign').mockImplementation(assign);
});

describe('returnToWithOAuthFlag', () => {
	it('flags the current path so the wizard can react on the way back', () => {
		expect(returnToWithOAuthFlag('/dashboard/postbox/migrate')).toBe(
			'/dashboard/postbox/migrate?oauthConnected=1'
		);
	});

	it('keeps existing query params and the hash', () => {
		expect(returnToWithOAuthFlag('/dashboard/delivery?tab=seed#coverage')).toBe(
			'/dashboard/delivery?tab=seed&oauthConnected=1#coverage'
		);
	});

	it('never produces an absolute URL, whatever it is handed', () => {
		// The backend refuses a `returnTo` that is not a same-site path — an
		// absolute one here would fail the connect instead of redirecting off-site,
		// but neither outcome is acceptable.
		expect(returnToWithOAuthFlag('https://evil.example/steal')).toBe('/steal?oauthConnected=1');
		expect(returnToWithOAuthFlag('//evil.example/steal')).toBe('/steal?oauthConnected=1');
	});
});

describe('useMailOAuthConnect', () => {
	it('sends the browser to the authorization URL the backend minted', async () => {
		const { connect, handedOffToBrowser } = useMailOAuthConnect();

		const started = await connect('google', { kind: 'connect' }, '/dashboard/postbox/migrate');

		expect(started).toBe(true);
		expect(run).toHaveBeenCalledWith({
			intent: { kind: 'connect' },
			returnTo: '/dashboard/postbox/migrate',
		});
		expect(assign).toHaveBeenCalledWith('https://accounts.google/x');
		expect(openExternal).not.toHaveBeenCalled();
		expect(handedOffToBrowser.value).toBe(false);
	});

	it('opens the consent screen in the system browser on the desktop app', async () => {
		isDesktopRuntime.mockReturnValue(true);
		const { connect, handedOffToBrowser } = useMailOAuthConnect();

		await connect('google', { kind: 'update' }, '/dashboard/postbox/migrate?oauthConnected=1');

		expect(openExternal).toHaveBeenCalledWith('https://accounts.google/x');
		// Navigating the webview itself would strand the user on a page with no
		// address bar and no back button.
		expect(assign).not.toHaveBeenCalled();
		// Drives the "finish in your browser" note — the webview stays put.
		expect(handedOffToBrowser.value).toBe(true);
	});

	it('falls back to in-app navigation when the desktop shell bridge refuses', async () => {
		isDesktopRuntime.mockReturnValue(true);
		openExternal.mockRejectedValueOnce(new Error('shell scope'));
		const { connect, handedOffToBrowser } = useMailOAuthConnect();

		await connect('google', { kind: 'connect' }, '/dashboard/postbox/migrate');

		expect(assign).toHaveBeenCalledWith('https://accounts.google/x');
		expect(handedOffToBrowser.value).toBe(false);
	});

	it('starts the Microsoft flow through the Microsoft action', async () => {
		const runs = { google: vi.fn(), microsoft: vi.fn() };
		let created = 0;
		vi.stubGlobal('useBackendOperation', () => {
			// The composable creates the Google operation first, then Microsoft's.
			const which = created++ === 0 ? 'google' : 'microsoft';
			runs[which].mockResolvedValue({
				ok: true,
				result: { authorizationUrl: `https://${which}.example/authorize` },
			});
			return { run: runs[which], isLoading: ref(false) };
		});
		const { connect } = useMailOAuthConnect();

		await connect('microsoft', { kind: 'connect' }, '/dashboard/postbox/migrate');

		expect(runs.google).not.toHaveBeenCalled();
		expect(runs.microsoft).toHaveBeenCalledWith({
			intent: { kind: 'connect' },
			returnTo: '/dashboard/postbox/migrate',
		});
		expect(assign).toHaveBeenCalledWith('https://microsoft.example/authorize');
	});

	it('navigates nowhere when the backend refused to start the flow', async () => {
		run.mockResolvedValueOnce({ ok: false });
		const { connect } = useMailOAuthConnect();

		const started = await connect('google', { kind: 'connect' }, '/dashboard/postbox/migrate');

		expect(started).toBe(false);
		expect(assign).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
	});
});
