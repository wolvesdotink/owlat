/**
 * "Copy link" for a conversation: one composable every surface copies through,
 * pointing at the web origin (the desktop workspace's, not the webview's), with
 * a toast for each outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { setActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import type { WorkspaceConfig } from '~/lib/desktop/workspaceTypes';
import { conversationLinkUrl, useConversationLink } from '../useConversationLink';

const showToast = vi.fn();
const writeText = vi.fn(async (_text: string) => {});
const TARGET = { kind: 'team', threadId: 'th1' } as const;

beforeEach(() => {
	showToast.mockClear();
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
	installNuxtStubs({ ...i18nStubs, useToast: () => ({ showToast }) });
});

const mounted: VueWrapper[] = [];
afterEach(() => {
	while (mounted.length) mounted.pop()!.unmount();
	setActiveWorkspace(null);
	delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

/** `useI18n` needs a component; the composable is only ever called from one. */
function useInComponent(): ReturnType<typeof useConversationLink> {
	let link!: ReturnType<typeof useConversationLink>;
	mounted.push(
		mount(
			defineComponent({
				setup() {
					link = useConversationLink();
					return () => h('div');
				},
			}),
			{ global: { plugins: [createTestI18n()] } }
		)
	);
	return link;
}

function asDesktop(siteUrl: string | null) {
	(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
	setActiveWorkspace(siteUrl === null ? null : ({ siteUrl } as WorkspaceConfig));
}

describe('useConversationLink', () => {
	it('copies the absolute link and says so', async () => {
		const { copyConversationLink } = useInComponent();
		await expect(copyConversationLink(TARGET)).resolves.toBe(true);
		expect(writeText).toHaveBeenCalledExactlyOnceWith(
			`${window.location.origin}/dashboard/inbox/th1`
		);
		expect(showToast).toHaveBeenCalledExactlyOnceWith('Link copied');
	});

	it('reports a refused clipboard write as a failure', async () => {
		writeText.mockRejectedValue(new Error('denied'));
		const { copyConversationLink } = useInComponent();
		await expect(copyConversationLink(TARGET)).resolves.toBe(false);
		expect(showToast).toHaveBeenCalledExactlyOnceWith('Could not copy the link', 'error');
	});

	it("links to the desktop workspace's web address", async () => {
		asDesktop('https://acme.owlat.example');
		expect(conversationLinkUrl(TARGET)).toBe('https://acme.owlat.example/dashboard/inbox/th1');
		await useInComponent().copyConversationLink(TARGET);
		expect(writeText).toHaveBeenCalledWith('https://acme.owlat.example/dashboard/inbox/th1');
	});

	it('copies nothing from a desktop app with no workspace address', async () => {
		asDesktop(null);
		expect(conversationLinkUrl(TARGET)).toBeNull();
		await expect(useInComponent().copyConversationLink(TARGET)).resolves.toBe(false);
		expect(writeText).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledExactlyOnceWith(
			'This workspace has no web address to link to',
			'error'
		);
	});
});
