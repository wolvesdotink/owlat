/**
 * PostboxUnsubscribeChip. Every click goes through the ONE unsubscribe path
 * (review r1, F6: `api.mail.senders.unsubscribeActions.unsubscribe`, local
 * suppression plus the guarded request with a recorded result), driven here
 * through the real `usePostboxSenderActions` over a stubbed backend.
 *
 * The non-one-click paths: the mailto target goes
 * through the shared RFC 6068 parser, so a List-Unsubscribe `mailto:?to=…`
 * (recipient in a `to` field, empty path) opens a prefilled composer. A mailto
 * with no To recipient falls back to the https page.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { ListUnsubscribeTarget } from '@owlat/shared/listUnsubscribe';

import PostboxUnsubscribeChip from '../PostboxUnsubscribeChip.vue';
import { installConfirm, type ConfirmDriver } from '~/__tests__/confirm';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxUnsubscribeOpen } from '~/composables/postbox/usePostboxUnsubscribeOpen';
import { usePostboxSenderActions } from '~/composables/postbox/usePostboxSenderActions';

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
let confirmDriver: ConfirmDriver;

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxComposeNav', () => ({ open: composeOpen }));
	// The real opener (shared with the Senders page) over the stubbed composer.
	vi.stubGlobal('usePostboxUnsubscribeOpen', usePostboxUnsubscribeOpen);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: oneClickRun, isLoading: ref(false) }));
	vi.stubGlobal('usePostboxSenderActions', usePostboxSenderActions);
});

beforeEach(() => {
	composeOpen.mockReset();
	oneClickRun.mockReset();
	windowOpen.mockReset();
	vi.spyOn(window, 'open').mockImplementation(windowOpen);
	confirmDriver = installConfirm();
	confirmDriver.answerAll(true);
});

afterEach(() => {
	confirmDriver.dispose();
	vi.restoreAllMocks();
});

/** The action's answer for a personal mailbox, echoing the message's own target. */
function serverAnswers(
	target: ListUnsubscribeTarget,
	result: 'confirmed' | 'failed' | null = null
) {
	const method =
		target.oneClick && target.httpUrl ? 'one_click' : target.mailtoUrl ? 'mailto' : 'https';
	oneClickRun.mockResolvedValue({
		ok: true,
		result: {
			scope: 'personal',
			profileId: 'p1',
			requestedAt: 1,
			operationId: 'op1',
			archived: 0,
			address: 'news@list.example',
			method,
			messageId: 'msg-1',
			...(target.httpUrl ? { httpUrl: target.httpUrl } : {}),
			...(target.mailtoUrl ? { mailtoUrl: target.mailtoUrl } : {}),
			result,
		},
	});
}

function mountChip(unsubscribe: ListUnsubscribeTarget) {
	serverAnswers(unsubscribe);
	return mount(PostboxUnsubscribeChip, {
		props: { messageId: 'msg-1', mailboxId: 'mbx-1', unsubscribe },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: { props: ['name'], template: '<span />' } },
		},
	});
}

describe('PostboxUnsubscribeChip', () => {
	it('unsubscribes one-click senders through the one path, behind the host confirm', async () => {
		const target = { httpUrl: 'https://list.example/unsub', oneClick: true };
		const wrapper = mountChip(target);
		serverAnswers(target, 'confirmed');
		await wrapper.get('button').trigger('click');
		await flushPromises();

		expect(confirmDriver.asked).toHaveLength(1);
		expect(confirmDriver.asked[0]).toMatchObject({
			title: 'Unsubscribe from this mailing list?',
			body: expect.stringContaining('list.example'),
			confirmText: 'Unsubscribe',
		});
		expect(oneClickRun).toHaveBeenCalledWith({ target: { messageId: 'msg-1' } });
		expect(wrapper.text()).toContain('Unsubscribed');
		expect(windowOpen).not.toHaveBeenCalled();
	});

	it('sends nothing until the question is answered, and nothing after a no', async () => {
		confirmDriver.answerAll(false);
		const target = { httpUrl: 'https://list.example/unsub', oneClick: true };
		const wrapper = mountChip(target);
		serverAnswers(target, 'confirmed');
		await wrapper.get('button').trigger('click');
		await flushPromises();

		expect(confirmDriver.asked).toHaveLength(1);
		expect(oneClickRun).not.toHaveBeenCalled();
		expect(wrapper.text()).not.toContain('Unsubscribed');
	});

	it('opens the sender page when the one-click request fails', async () => {
		const target = { httpUrl: 'https://list.example/unsub', oneClick: true };
		const wrapper = mountChip(target);
		serverAnswers(target, 'failed');
		await wrapper.get('button').trigger('click');
		await flushPromises();

		expect(windowOpen).toHaveBeenCalledWith(
			'https://list.example/unsub',
			'_blank',
			'noopener,noreferrer'
		);
	});

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
