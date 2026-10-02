// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import NoteComposer from '../NoteComposer.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
enableAutoUnmount(afterEach);

/**
 * The note box: says only the team sees it, offers teammates on `@`, saves with
 * Ctrl/Cmd+Enter and keeps the text until the save succeeds.
 */
const BEN = {
	memberId: 'u_ben',
	name: 'Ben',
	email: 'ben@example.com',
	image: null,
	handle: 'ben',
};
const PickerStub = {
	name: 'ChatMentionPicker',
	props: ['candidates'],
	emits: ['pick'],
	template:
		'<div data-testid="picker"><button v-for="c in candidates" :key="c.memberId" @mousedown.prevent="$emit(\'pick\', c.handle)">{{ c.handle }}</button></div>',
};

function mountComposer(submit = vi.fn(async () => true)) {
	const candidatesFor = vi.fn((q: string) => ('ben'.startsWith(q) ? [BEN] : []));
	const wrapper = mount(NoteComposer, {
		props: { submit, candidatesFor },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, ChatMentionPicker: PickerStub },
		},
	});
	return { wrapper, submit, candidatesFor };
}

async function type(wrapper: ReturnType<typeof mountComposer>['wrapper'], text: string) {
	const box = wrapper.get<HTMLTextAreaElement>('[data-testid="note-composer-input"]');
	await box.setValue(text);
	box.element.setSelectionRange(text.length, text.length);
	await box.trigger('input');
	return box;
}

describe('NoteComposer', () => {
	it('says only the team sees the note', () => {
		const { wrapper } = mountComposer();
		expect(wrapper.text()).toContain('only your team sees this');
	});

	it('offers teammates on @ and writes the picked handle', async () => {
		const { wrapper } = mountComposer();
		const box = await type(wrapper, 'ask @b');
		expect(wrapper.get('[data-testid="picker"]').text()).toBe('ben');
		await wrapper.get('[data-testid="picker"] button').trigger('mousedown');
		expect(box.element.value).toBe('ask @ben ');
		expect(wrapper.find('[data-testid="picker"]').exists()).toBe(false);
	});

	it('saves with Ctrl+Enter and clears only after the save succeeded', async () => {
		const submit = vi.fn(async () => false);
		const { wrapper } = mountComposer(submit);
		const box = await type(wrapper, 'Refund queued');
		await box.trigger('keydown', { key: 'Enter', ctrlKey: true });
		await flushPromises();
		expect(submit).toHaveBeenCalledWith('Refund queued');
		expect(box.element.value).toBe('Refund queued');

		submit.mockResolvedValue(true);
		await wrapper.get('[data-testid="note-composer-save"]').trigger('click');
		await flushPromises();
		expect(box.element.value).toBe('');
		expect(wrapper.emitted('saved')).toHaveLength(1);
	});

	it('will not save an empty note or one past the limit', async () => {
		const { wrapper, submit } = mountComposer();
		await type(wrapper, '   ');
		await wrapper.get('[data-testid="note-composer-save"]').trigger('click');
		await type(wrapper, 'x'.repeat(5_001));
		expect(wrapper.get('[data-testid="note-composer-hint"]').text()).toContain('too long');
		await wrapper.get('[data-testid="note-composer-save"]').trigger('click');
		await flushPromises();
		expect(submit).not.toHaveBeenCalled();
	});
});
