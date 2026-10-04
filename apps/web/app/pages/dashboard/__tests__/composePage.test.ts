// @vitest-environment happy-dom
/**
 * The full-page composer (pages/dashboard/compose.vue), which replaced the
 * floating popup in the corner. It has to seed the composer from whatever
 * opened it (a parked seed, a saved draft, a plain prefill), write the draft id
 * into its URL once the row exists so a reload lands on the same draft, and go
 * back to the page it came from after a send or a discard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';

import ComposePage from '../compose.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: {
		seed: { type: Object, required: true },
		frame: { type: String, default: undefined },
		replyAllRecipients: { type: Array, default: undefined },
	},
	emits: ['sent', 'discarded', 'draft-id', 'subject', 'minimize'],
	template: '<div data-testid="composer" />',
});

let query: Record<string, string>;
const replace = vi.fn(async () => {});
const back = vi.fn();
const navigate = vi.fn(async () => {});
const parked: Record<string, unknown> = {};

beforeEach(() => {
	query = {};
	replace.mockClear();
	back.mockClear();
	navigate.mockClear();
	window.history.replaceState({ back: '/dashboard/postbox/inbox' }, '');
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', () => {});
	vi.stubGlobal('definePageMeta', () => {});
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useRoute', () => ({ query }));
	vi.stubGlobal('useRouter', () => ({ replace, back }));
	vi.stubGlobal('usePostboxMailbox', () => ({
		currentMailbox: ref({ _id: 'mbx-1' }),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxComposeNav', () => ({ seedFor: (key: string) => parked[key] ?? null }));
});

function mountPage() {
	return mount(ComposePage, {
		global: {
			plugins: [createTestI18n()],
			components: { PostboxComposer: ComposerStub },
			stubs: { Icon: true, UiSkeleton: true },
		},
	});
}

describe('compose page', () => {
	it('opens a new message on the current mailbox in the page frame', () => {
		const composer = mountPage().getComponent(ComposerStub);
		expect(composer.props('frame')).toBe('page');
		expect(composer.props('seed')).toMatchObject({ mailboxId: 'mbx-1' });
	});

	it('takes a seed parked by usePostboxComposeNav', () => {
		parked['k1'] = {
			mailboxId: 'mbx-2',
			prefillTo: ['jonas@example.com'],
			prefillSubject: 'Fwd: Q3',
		};
		query = { seed: 'k1' };
		expect(mountPage().getComponent(ComposerStub).props('seed')).toEqual(parked['k1']);
	});

	it('reopens a saved draft named in the URL', () => {
		query = { mailbox: 'mbx-3', draft: 'draft-9' };
		expect(mountPage().getComponent(ComposerStub).props('seed')).toEqual({
			mailboxId: 'mbx-3',
			draftId: 'draft-9',
		});
	});

	it('prefills recipients and subject from a plain link', () => {
		query = { to: 'ada@example.com, bob@example.com', subject: 'Hi' };
		expect(mountPage().getComponent(ComposerStub).props('seed')).toMatchObject({
			mailboxId: 'mbx-1',
			prefillTo: ['ada@example.com', 'bob@example.com'],
			prefillSubject: 'Hi',
		});
	});

	it('writes the draft id into the URL once the row exists', () => {
		mountPage().getComponent(ComposerStub).vm.$emit('draft-id', 'draft-1');
		expect(replace).toHaveBeenCalledWith({ query: { mailbox: 'mbx-1', draft: 'draft-1' } });
	});

	it('goes back to the page it came from after a send or a discard', () => {
		const wrapper = mountPage();
		wrapper.getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		wrapper.getComponent(ComposerStub).vm.$emit('discarded');
		expect(back).toHaveBeenCalledTimes(2);
	});

	it('lands on the inbox when it was opened directly', () => {
		window.history.replaceState({}, '');
		mountPage().getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		expect(back).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});
});
