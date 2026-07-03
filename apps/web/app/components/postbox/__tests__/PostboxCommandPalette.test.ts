// @vitest-environment happy-dom
/**
 * PostboxCommandPalette progressive-disclosure coverage:
 *   - the palette lists the actions that were demoted into the reader's ⋯
 *     overflow / hover-only affordances (reply-all, forward, report spam,
 *     block sender, move, print) so they stay discoverable
 *   - running one dispatches `owlat:postbox-reader-action` with its action id
 *     (the open conversation's reader listens for this)
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, onBeforeUnmount } from 'vue';

vi.mock('~/lib/globalSwitcher', () => ({
	usePostboxPaletteMounted: () => ref(0),
}));

import PostboxCommandPalette from '../PostboxCommandPalette.vue';

beforeAll(() => {
	// Nuxt auto-imports this globally in the app; the vitest setup polyfills
	// only onMounted/onUnmounted, so add the one this component also uses.
	vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
	vi.stubGlobal('usePostboxComposerStack', () => ({ open: vi.fn() }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('navigateTo', vi.fn());
});

const iconStub = { props: ['name'], template: '<span />' };
// Render the modal slot unconditionally so the command list is inspectable
// without simulating the Cmd-K open handshake.
const modalStub = { template: '<div><slot /></div>' };

function mountPalette() {
	return mount(PostboxCommandPalette, {
		props: { mailboxId: 'mbx-1' },
		global: { stubs: { Icon: iconStub, UiModal: modalStub } },
	});
}

describe('PostboxCommandPalette progressive disclosure', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('lists the demoted reader actions', () => {
		const wrapper = mountPalette();
		const text = wrapper.text();
		for (const label of [
			'Reply all',
			'Forward',
			'Report spam',
			'Block sender',
			'Move conversation…',
			'Print conversation',
		]) {
			expect(text).toContain(label);
		}
	});

	it('dispatches a reader-action event when a demoted command runs', async () => {
		const dispatch = vi.spyOn(window, 'dispatchEvent');
		const wrapper = mountPalette();

		const replyAll = wrapper
			.findAll('button[role="option"]')
			.find((b) => b.text().includes('Reply all'));
		expect(replyAll).toBeTruthy();
		await replyAll!.trigger('click');

		const evt = dispatch.mock.calls
			.map((c) => c[0])
			.find((e): e is CustomEvent => e.type === 'owlat:postbox-reader-action');
		expect(evt).toBeTruthy();
		expect((evt as CustomEvent).detail).toEqual({ action: 'replyAll' });
	});
});
