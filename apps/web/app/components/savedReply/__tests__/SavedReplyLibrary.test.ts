// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import SavedReplyLibrary from '../SavedReplyLibrary.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

/**
 * The management list of one scope's saved replies: most used first with how
 * often and when, the inboxes a shared one is limited to, read-only for a
 * member who may not change shared replies, and the form that adds one.
 */
const mine = ref<unknown[] | undefined>([]);
const shared = ref<{ canManage: boolean; replies: unknown[] } | undefined>(undefined);
const run = vi.fn(async () => ({ ok: true, result: 'sn_new' }));
let calls = 0;

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useFeatureFlag: () => ({ isEnabled: () => true }),
		// `useSavedReplyLibrary` subscribes to `listMine`, then `listShared`.
		useConvexQuery: () => {
			calls += 1;
			return {
				data: calls % 2 === 1 ? mine : shared,
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			};
		},
		useBackendOperation: () => ({ run, isLoading: ref(false) }),
	});
});
enableAutoUnmount(afterEach);
afterEach(() => run.mockClear());

function reply(overrides: Record<string, unknown>) {
	return {
		_id: 'sn_x',
		name: 'Reply',
		shortcut: '',
		bodyHtml: '<p>Text</p>',
		variables: undefined,
		scope: 'personal',
		mailboxIds: [],
		useCount: 0,
		lastUsedAt: null,
		updatedAt: 1,
		...overrides,
	};
}

function mountLibrary(props: Record<string, unknown>) {
	return mount(SavedReplyLibrary, {
		props,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiConfirmationDialog: true,
				PostboxBasicEditor: {
					props: ['modelValue'],
					emits: ['update:modelValue'],
					template:
						'<textarea data-testid="body" :value="modelValue" @input="$emit(`update:modelValue`, $event.target.value)" />',
				},
				PostboxSnippetVariableEditor: true,
				I18nT: true,
			},
		},
	});
}

describe('SavedReplyLibrary', () => {
	it('lists personal replies most used first, with how often they were used', () => {
		mine.value = [
			reply({ _id: 'a', name: 'Rarely', useCount: 1, lastUsedAt: Date.now() }),
			reply({ _id: 'b', name: 'Often', shortcut: 'often', useCount: 9, lastUsedAt: Date.now() }),
			reply({ _id: 'c', name: 'Never' }),
		];
		const wrapper = mountLibrary({ scope: 'personal' });
		const rows = wrapper.findAll('[data-testid="saved-reply-list"] li');
		expect(rows.map((row) => row.find('.font-medium').text())).toEqual([
			'Often',
			'Rarely',
			'Never',
		]);
		expect(rows[0]?.text()).toContain(';often');
		expect(rows[0]?.text()).toContain('Used 9 times');
		expect(rows[2]?.text()).toContain('Not used yet');
		expect(wrapper.find('[data-testid="saved-reply-new"]').exists()).toBe(true);
	});

	it('says so when there is nothing yet', () => {
		mine.value = [];
		expect(mountLibrary({ scope: 'personal' }).text()).toContain('No saved replies yet');
	});

	it('shows shared replies read-only to a member who may not change them', () => {
		shared.value = {
			canManage: false,
			replies: [reply({ _id: 's', name: 'Hours', scope: 'shared', mailboxIds: ['mb_1'] })],
		};
		const wrapper = mountLibrary({
			scope: 'shared',
			teamInboxes: [{ _id: 'mb_1', label: 'Support' }],
		});
		expect(wrapper.text()).toContain('Only in Support');
		expect(wrapper.find('[data-testid="saved-reply-new"]').exists()).toBe(false);
		expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('Edit');
	});

	it('adds a shared reply limited to the inboxes an admin ticks', async () => {
		shared.value = { canManage: true, replies: [] };
		const wrapper = mountLibrary({
			scope: 'shared',
			teamInboxes: [
				{ _id: 'mb_1', label: 'Support' },
				{ _id: 'mb_2', label: 'Sales' },
			],
		});
		await wrapper.get('[data-testid="saved-reply-new"]').trigger('click');
		const editor = wrapper.get('[data-testid="saved-reply-editor"]');
		const [name, shortcut] = editor.findAll('input[type="text"]');
		await name?.setValue('Refunds');
		await shortcut?.setValue(';Refund Policy');
		await editor.get('[data-testid="body"]').setValue('<p>Hi</p>');
		await editor.findAll('input[type="checkbox"]')[1]?.setValue(true);
		await editor.trigger('submit');
		await nextTick();

		expect(run).toHaveBeenCalledWith({
			scope: 'shared',
			name: 'Refunds',
			shortcut: ';Refund Policy',
			bodyHtml: '<p>Hi</p>',
			variables: [],
			mailboxIds: ['mb_2'],
		});
	});
});
