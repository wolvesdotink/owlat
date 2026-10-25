/**
 * useRowLinkMenu: the link verbs every linked row's menu ends with. A copied
 * link must open outside the app, so on the desktop it is built on the
 * connected instance's web origin, never the webview's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import { setActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import type { WorkspaceConfig } from '~/lib/desktop/workspaceTypes';
import { useRowLinkMenu } from '../useRowLinkMenu';

const copied: string[] = [];
vi.mock('~/composables/useCopyToClipboard', () => ({
	useCopyToClipboard: () => ({
		copy: async (text: string) => {
			copied.push(text);
			return true;
		},
	}),
}));
vi.mock('@owlat/ui/composables/useToast', () => ({
	useToast: () => ({ showToast: vi.fn() }),
}));

const i18n = createTestI18n();

beforeEach(() => {
	copied.length = 0;
	vi.stubGlobal('useI18n', () => i18n.global);
});

afterEach(() => {
	setActiveWorkspace(null);
	delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
	vi.unstubAllGlobals();
});

// The clipboard write starts synchronously inside `run`.
function runItem(id: string, to: string) {
	const item = useRowLinkMenu()
		.linkItems(to)
		.find((entry) => entry.id === id);
	expect(item, id).toBeTruthy();
	item!.run();
}

describe('useRowLinkMenu', () => {
	it('copies a link on the page origin in the browser, and offers a new tab', () => {
		const items = useRowLinkMenu().linkItems('/dashboard/inbox/a');
		expect(items.map((item) => item.id)).toEqual(['open-new-tab', 'copy-link']);
		runItem('copy-link', '/dashboard/inbox/a');
		expect(copied).toEqual([`${window.location.origin}/dashboard/inbox/a`]);
	});

	it('copies a link on the connected instance on the desktop, not the webview', () => {
		(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
		setActiveWorkspace({ siteUrl: 'https://mail.example.com' } as WorkspaceConfig);
		const items = useRowLinkMenu().linkItems('/dashboard/inbox/a');
		// The desktop app has no tabs.
		expect(items.map((item) => item.id)).toEqual(['copy-link']);
		runItem('copy-link', '/dashboard/inbox/a');
		expect(copied).toEqual(['https://mail.example.com/dashboard/inbox/a']);
	});

	it('offers no link on a desktop with no connected instance', () => {
		(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
		expect(useRowLinkMenu().linkItems('/dashboard/inbox/a')).toEqual([]);
	});
});
