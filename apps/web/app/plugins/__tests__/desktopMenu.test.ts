/**
 * The native application-menu bridge (`1.desktop-menu.client.ts`).
 *
 * It is in every browser's boot bundle, so the deep-link handler a mailto:
 * click needs is imported when one arrives rather than with the plugin. These
 * cases pin that the mailto: route still reaches the handler, that the tray's
 * "Pause Notifications" flips the stored switch and its "Check for Mail" asks
 * the backend through the app's Convex client, and that the web runtime
 * registers nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let desktopRuntime = true;
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => desktopRuntime,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: 'main' }),
}));

const onMenuAction = vi.fn(async (_action: string, _handler: () => void) => () => {});
let mailtoHandler: ((url: string) => void) | null = null;
const onOpenMailto = vi.fn(async (handler: (url: string) => void) => {
	mailtoHandler = handler;
	return () => {};
});
vi.mock('@owlat/desktop/src/menu', () => ({
	onMenuAction: (action: string, handler: () => void) => onMenuAction(action, handler),
	onOpenMailto: (handler: (url: string) => void) => onOpenMailto(handler),
}));

let trayToggleHandler: (() => void) | null = null;
const onTrayToggleNotifications = vi.fn(async (handler: () => void) => {
	trayToggleHandler = handler;
	return () => {};
});
let trayCheckHandler: (() => void) | null = null;
const onTrayCheckMail = vi.fn(async (handler: () => void) => {
	trayCheckHandler = handler;
	return () => {};
});
vi.mock('@owlat/desktop/src/tray', () => ({
	onTrayToggleNotifications: (handler: () => void) => onTrayToggleNotifications(handler),
	onTrayCheckMail: (handler: () => void) => onTrayCheckMail(handler),
}));

const checkForMail = vi.fn(async (_deps: unknown) => 'checking');
vi.mock('~/lib/postboxCheckForMail', () => ({
	checkForMail: (deps: unknown) => checkForMail(deps),
}));

const convexClient = { mutation: vi.fn() };
const showToast = vi.fn();

let storedNotificationsEnabled = true;
const setGlobal = vi.fn();
vi.mock('~/composables/useDesktopAppSettings', () => ({
	loadDesktopAppSettings: async () => ({
		global: { notificationsEnabled: storedNotificationsEnabled },
	}),
	useDesktopAppSettings: () => ({ setGlobal }),
}));

const deepLinkModuleLoads = vi.fn();
const handleDeepLink = vi.fn(async (_url: string) => {});
vi.mock('~/lib/desktop/deepLink.client', () => {
	deepLinkModuleLoads();
	return { handleDeepLink: (url: string) => handleDeepLink(url) };
});

type MenuPlugin = { setup: (nuxtApp: unknown) => void };

async function setupMenuPlugin(): Promise<void> {
	vi.resetModules();
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useCommandPalette', () => ({ open: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	const plugin = (await import('../1.desktop-menu.client')).default as unknown as MenuPlugin;
	plugin.setup({ $convex: convexClient, $i18n: { t: (key: string) => `t:${key}` } });
}

beforeEach(() => {
	desktopRuntime = true;
	mailtoHandler = null;
	trayToggleHandler = null;
	trayCheckHandler = null;
	onTrayCheckMail.mockClear();
	checkForMail.mockClear();
	storedNotificationsEnabled = true;
	setGlobal.mockClear();
	onTrayToggleNotifications.mockClear();
	onMenuAction.mockClear();
	onOpenMailto.mockClear();
	deepLinkModuleLoads.mockClear();
	handleDeepLink.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('desktop menu plugin', () => {
	it('opens a mailto: from the menu bridge through the deep-link handler', async () => {
		await setupMenuPlugin();
		await vi.waitFor(() => expect(onOpenMailto).toHaveBeenCalledTimes(1));
		expect(onMenuAction).toHaveBeenCalledWith('preferences', expect.any(Function));
		expect(deepLinkModuleLoads).not.toHaveBeenCalled();

		mailtoHandler?.('mailto:ada@example.com?subject=Hello');

		await vi.waitFor(() =>
			expect(handleDeepLink).toHaveBeenCalledWith('mailto:ada@example.com?subject=Hello')
		);
	});

	it('flips the stored notification switch from the tray, both ways', async () => {
		await setupMenuPlugin();
		await vi.waitFor(() => expect(onTrayToggleNotifications).toHaveBeenCalledTimes(1));

		trayToggleHandler?.();
		await vi.waitFor(() => expect(setGlobal).toHaveBeenCalledWith('notificationsEnabled', false));

		storedNotificationsEnabled = false;
		trayToggleHandler?.();
		await vi.waitFor(() =>
			expect(setGlobal).toHaveBeenLastCalledWith('notificationsEnabled', true)
		);
	});

	it("checks for mail from the tray with the app's Convex client", async () => {
		await setupMenuPlugin();
		await vi.waitFor(() => expect(onTrayCheckMail).toHaveBeenCalledTimes(1));
		expect(checkForMail).not.toHaveBeenCalled();

		trayCheckHandler?.();
		await vi.waitFor(() => expect(checkForMail).toHaveBeenCalledTimes(1));
		const deps = checkForMail.mock.calls[0]![0] as {
			client: unknown;
			t: (key: string) => string;
			showToast: unknown;
		};
		expect(deps.client).toBe(convexClient);
		expect(deps.t('postbox.checkForMail.checking')).toBe('t:postbox.checkForMail.checking');
		expect(deps.showToast).toBe(showToast);
	});

	it('registers nothing on the web', async () => {
		desktopRuntime = false;

		await setupMenuPlugin();
		for (let i = 0; i < 20; i += 1) await Promise.resolve();

		expect(onMenuAction).not.toHaveBeenCalled();
		expect(onOpenMailto).not.toHaveBeenCalled();
		expect(onTrayToggleNotifications).not.toHaveBeenCalled();
		expect(onTrayCheckMail).not.toHaveBeenCalled();
		expect(deepLinkModuleLoads).not.toHaveBeenCalled();
	});
});
