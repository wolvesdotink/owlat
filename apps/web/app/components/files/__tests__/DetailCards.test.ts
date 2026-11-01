/**
 * The file detail page's editable cards: the tags card saves the comma list it
 * was given, trimmed and without empties; the conversation card clears its link
 * with an explicit `null` (an omitted arg would mean "unchanged"). Both leave
 * the edit control to admins, as the backend's update is admin-only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { contactPickerLabel } from '~/utils/contactPicker';
import { threadPickerLabel } from '~/utils/threadPicker';
import FilesDetailTagsCard from '../DetailTagsCard.vue';
import FilesDetailThreadCard from '../DetailThreadCard.vue';

const updateFile = vi.fn(async () => ({ ok: true as const, result: null }));
const showToast = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast }),
		useBackendOperation: () => ({ run: updateFile, isLoading: ref(false) }),
	});
});

/** The thread picker hands back whatever it was given, so a test can clear it. */
const ThreadPickerStub = defineComponent({
	props: { modelValue: { type: Object, default: null } },
	emits: ['update:modelValue'],
	template: '<button data-testid="clear-thread" @click="$emit(\'update:modelValue\', null)" />',
});

function mountCard(component: unknown, props: Record<string, unknown>) {
	return mount(component as never, {
		props: { fileId: 'file_1', isAdmin: true, ...props },
		global: {
			plugins: [createTestI18n()],
			mocks: { contactPickerLabel, threadPickerLabel },
			stubs: { FilesThreadPicker: ThreadPickerStub },
		},
	});
}

describe('FilesDetailTagsCard', () => {
	it('saves the edited tags trimmed, without empties', async () => {
		const wrapper = mountCard(FilesDetailTagsCard, { tags: ['contract'], autoTags: ['legal'] });
		expect(wrapper.text()).toContain('contract');
		expect(wrapper.text()).toContain('legal');

		await wrapper.get('button').trigger('click');
		const input = wrapper.get('input');
		expect((input.element as HTMLInputElement).value).toBe('contract');
		await input.setValue(' contract , ,signed ');
		await input.trigger('keyup.enter');
		await flushPromises();

		expect(updateFile).toHaveBeenCalledWith({ fileId: 'file_1', tags: ['contract', 'signed'] });
		expect(showToast).toHaveBeenCalledTimes(1);
		expect(wrapper.find('input').exists()).toBe(false);
	});

	it('offers no edit control to a member', () => {
		const wrapper = mountCard(FilesDetailTagsCard, { tags: ['contract'], isAdmin: false });
		expect(wrapper.find('button').exists()).toBe(false);
	});
});

describe('FilesDetailThreadCard', () => {
	it('links the conversation and clears the link with an explicit null', async () => {
		const wrapper = mountCard(FilesDetailThreadCard, {
			threadId: 'thread_1',
			threadSubject: 'Invoice 4471',
		});
		expect(wrapper.get('a').attributes('href')).toBe('/dashboard/inbox/thread_1');
		expect(wrapper.text()).toContain('Invoice 4471');

		await wrapper.get('button').trigger('click');
		await wrapper.get('[data-testid="clear-thread"]').trigger('click');
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Save')!
			.trigger('click');
		await flushPromises();

		expect(updateFile).toHaveBeenCalledWith({ fileId: 'file_1', threadId: null });
	});
});
