/**
 * The native application-menu bridge (`1.desktop-menu.client.ts`).
 *
 * It is in every browser's boot bundle, so the deep-link handler a mailto:
 * click needs is imported when one arrives rather than with the plugin. These
 * cases pin that the mailto: route still reaches the handler, and that the web
 * runtime registers nothing.
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

const deepLinkModuleLoads = vi.fn();
const handleDeepLink = vi.fn(async (_url: string) => {});
vi.mock('~/lib/desktop/deepLink.client', () => {
	deepLinkModuleLoads();
	return { handleDeepLink: (url: string) => handleDeepLink(url) };
});

type MenuPlugin = { setup: () => void };

async function setupMenuPlugin(): Promise<void> {
	vi.resetModules();
	vi.stubGlobal('defineNuxtPlugin', (def: unknown) => def);
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useCommandPalette', () => ({ open: vi.fn() }));
	const plugin = (await import('../1.desktop-menu.client')).default as unknown as MenuPlugin;
	plugin.setup();
}

beforeEach(() => {
	desktopRuntime = true;
	mailtoHandler = null;
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

	it('registers nothing on the web', async () => {
		desktopRuntime = false;

		await setupMenuPlugin();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onMenuAction).not.toHaveBeenCalled();
		expect(onOpenMailto).not.toHaveBeenCalled();
		expect(deepLinkModuleLoads).not.toHaveBeenCalled();
	});
});
