// @vitest-environment happy-dom
/**
 * PostboxUnsubscribeChip's non-one-click paths (issue #864, finding 10). The
 * mailto target goes through the shared RFC 6068 parser, so a List-Unsubscribe
 * `mailto:?to=…` (recipient in a `to` field, empty path) opens a prefilled
 * composer. A mailto with no To recipient falls back to the https page.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { ListUnsubscribeTarget } from '@owlat/shared/listUnsubscribe';

import PostboxUnsubscribeChip from '../PostboxUnsubscribeChip.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const composeOpen = vi.fn();
const oneClickRun = vi.fn();
const windowOpen = vi.fn();

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxComposeNav', () => ({ open: composeOpen }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: oneClickRun, isLoading: ref(false) }));
});

beforeEach(() => {
	composeOpen.mockReset();
	oneClickRun.mockReset();
	windowOpen.mockReset();
	vi.spyOn(window, 'open').mockImplementation(windowOpen);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function mountChip(unsubscribe: ListUnsubscribeTarget) {
	return mount(PostboxUnsubscribeChip, {
		props: { messageId: 'msg-1', mailboxId: 'mbx-1', unsubscribe },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: { props: ['name'], template: '<span />' } },
		},
	});
}

describe('PostboxUnsubscribeChip', () => {
	it('opens a composer for a recipient given only in a `to` field', async () => {
		const wrapper = mountChip({
			mailtoUrl: 'mailto:?to=unsub@list.example&subject=unsubscribe',
			httpUrl: 'https://list.example/unsub',
			oneClick: false,
		});
		await wrapper.get('button').trigger('click');
		await flushPromises();

		expect(composeOpen).toHaveBeenCalledWith({
			mailboxId: 'mbx-1',
			prefillTo: ['unsub@list.example'],
			prefillSubject: 'unsubscribe',
		});
		expect(windowOpen).not.toHaveBeenCalled();
	});

	it('escapes a hostile mailto body before seeding the composer', async () => {
		const wrapper = mountChip({
			mailtoUrl: 'mailto:unsub@evil.test?body=%3Cimg%20src%3Dx%3E',
			oneClick: false,
		});
		await wrapper.get('button').trigger('click');
		await flushPromises();

		expect(composeOpen).toHaveBeenCalledWith(
			expect.objectContaining({
				prefillTo: ['unsub@evil.test'],
				prefillSubject: 'Unsubscribe',
				prefillBodyHtml: '<p>&lt;img src=x&gt;</p>',
			})
		);
	});

	it('falls back to the https page when the mailto names no To recipient', async () => {
		const wrapper = mountChip({
			mailtoUrl: 'mailto:?subject=x&cc=someone@list.example',
			httpUrl: 'https://list.example/unsub',
			oneClick: false,
		});
		await wrapper.get('button').trigger('click');
		await flushPromises();

		expect(composeOpen).not.toHaveBeenCalled();
		expect(windowOpen).toHaveBeenCalledWith(
			'https://list.example/unsub',
			'_blank',
			'noopener,noreferrer'
		);
	});
});
