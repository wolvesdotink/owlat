// @vitest-environment happy-dom
/**
 * The team composer (plan §4.3): "Internal note" and "Reply to <name>" are
 * explicit modes, each with its own unsent text; `#` links a note to an
 * action; the reply hands its text to Answer mode; and with the `chat`
 * feature off a shared mailbox offers only the reply.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import TeamNoteComposer from '../TeamNoteComposer.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { teamView } from '~/utils/__tests__/teamStreamFixtures';
import { linkableItems } from '~/utils/teamStream';

const states = new Map<string, ReturnType<typeof ref>>();
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useState: (key: string, init: () => unknown) => {
			if (!states.has(key)) states.set(key, ref(init()));
			return states.get(key);
		},
	});
});
beforeEach(() => states.clear());

const Button = defineComponent({
	props: { disabled: Boolean },
	emits: ['click'],
	setup:
		(props, { slots, emit }) =>
		() =>
			h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots['default']?.()),
});

function mountComposer(props: Record<string, unknown> = {}) {
	const submitNote = vi.fn(async () => true);
	const w = mount(TeamNoteComposer, {
		props: {
			draftKey: 'team:th1',
			replyName: 'Ana Costa',
			items: linkableItems(teamView()),
			submitNote,
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			components: { UiButton: Button, ChatMentionPicker: defineComponent(() => () => h('div')) },
			stubs: { Icon: true },
		},
	});
	return { w, submitNote };
}

describe('TeamNoteComposer', () => {
	it('keeps a separate unsent text per mode', async () => {
		const { w } = mountComposer();
		expect(w.attributes('data-mode')).toBe('note');
		await w.find('[data-testid="team-composer-note-input"]').setValue('for the team');
		await w.find('[data-testid="team-composer-mode-reply"]').trigger('click');
		expect(w.attributes('data-mode')).toBe('reply');
		const replyBox = w.find('[data-testid="team-composer-reply-input"]');
		expect((replyBox.element as HTMLTextAreaElement).value).toBe('');
		await replyBox.setValue('Hi Ana');
		await w.find('[data-testid="team-composer-mode-note"]').trigger('click');
		expect(
			(w.find('[data-testid="team-composer-note-input"]').element as HTMLTextAreaElement).value
		).toBe('for the team');
		expect(w.emitted('update:replyDraft')?.at(-1)).toEqual(['Hi Ana']);
		expect(w.text()).toContain('Reply to Ana Costa');
		expectFullyLocalized(w);
	});

	it('links the note to an action picked with #, and posts both', async () => {
		const { w, submitNote } = mountComposer();
		const box = w.find('[data-testid="team-composer-note-input"]');
		const el = box.element as HTMLTextAreaElement;
		await box.setValue('refund is fine #refu');
		el.setSelectionRange(el.value.length, el.value.length);
		await box.trigger('input');
		const picker = w.find('[data-testid="team-composer-item-picker"]');
		expect(picker.text()).toContain('Refund €129.00 for order #4471');
		await picker.find('button').trigger('mousedown');
		expect(w.find('[data-testid="team-composer-linked-item"]').text()).toContain('Refund €129.00');
		await w.find('[data-testid="team-composer-post"]').trigger('click');
		await nextTick();
		expect(submitNote).toHaveBeenCalledWith('refund is fine', 'i_refund');
	});

	it('hands the reply text to Answer mode', async () => {
		const { w } = mountComposer({ mode: 'reply', replyDraft: 'Hi Ana, sorry' });
		await w.find('[data-testid="team-composer-continue"]').trigger('click');
		expect(w.emitted('reply')).toEqual([['Hi Ana, sorry']]);
	});

	it('offers only the reply when notes are off (chat off on a shared mailbox)', () => {
		const { w } = mountComposer({ notesEnabled: false });
		expect(w.attributes('data-mode')).toBe('reply');
		expect(w.find('[data-testid="team-composer-mode-note"]').exists()).toBe(false);
		expect(w.find('[data-testid="team-composer-note-input"]').exists()).toBe(false);
	});
});
