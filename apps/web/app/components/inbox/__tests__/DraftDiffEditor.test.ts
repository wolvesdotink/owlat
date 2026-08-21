import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import DraftDiffEditor from '../DraftDiffEditor.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// Every visible string flows through vue-i18n now: mount with the real catalog
// and expose `useI18n`, which is a Nuxt auto-import in the app.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/**
 * The review-gate draft editor shows a live before/after diff of the original
 * agent draft vs the reviewer's edit, with Apply (commit) / Discard (revert).
 */
function mountEditor(props: {
	original: string;
	modelValue: string;
	saving?: boolean;
	held?: boolean;
	showSave?: boolean;
}) {
	return mount(DraftDiffEditor, {
		props,
		// `<Icon>` is a Nuxt auto-import that is not registered in unit tests.
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('InboxDraftDiffEditor', () => {
	it('shows the before/after diff of the original vs the edit when they differ', () => {
		const wrapper = mountEditor({ original: 'Hello there.', modelValue: 'Hello there, friend!' });

		const diff = wrapper.find('[data-testid="draft-diff"]');
		expect(diff.exists()).toBe(true);
		expect(wrapper.get('[data-testid="draft-diff-original"]').text()).toBe('Hello there.');
		expect(wrapper.get('[data-testid="draft-diff-edited"]').text()).toBe('Hello there, friend!');
	});

	it('hides the diff when the edit only differs by surrounding whitespace', () => {
		const wrapper = mountEditor({ original: 'Same text', modelValue: '  Same text  ' });
		expect(wrapper.find('[data-testid="draft-diff"]').exists()).toBe(false);
	});

	it('Apply commits the edit (emits apply)', async () => {
		const wrapper = mountEditor({ original: 'Original', modelValue: 'Edited body' });
		await wrapper.get('[data-testid="draft-diff-apply"]').trigger('click');
		expect(wrapper.emitted('apply')).toHaveLength(1);
	});

	it('Discard reverts the text to the original and closes the editor', async () => {
		const wrapper = mountEditor({ original: 'Original body', modelValue: 'Edited body' });
		await wrapper.get('[data-testid="draft-diff-discard"]').trigger('click');

		// Reverts the working edit back to the original...
		const updates = wrapper.emitted('update:modelValue');
		expect(updates?.at(-1)).toEqual(['Original body']);
		// ...and asks the parent to close the edit session.
		expect(wrapper.emitted('discard')).toHaveLength(1);
	});

	it('typing in the textarea propagates the edit through v-model', async () => {
		const wrapper = mountEditor({ original: 'Original', modelValue: 'Original' });
		const textarea = wrapper.get('textarea');
		(textarea.element as HTMLTextAreaElement).value = 'Original plus more';
		await textarea.trigger('input');

		const updates = wrapper.emitted('update:modelValue');
		expect(updates?.at(-1)).toEqual(['Original plus more']);
	});

	it('disables both actions while saving', () => {
		const wrapper = mountEditor({ original: 'Original', modelValue: 'Edited', saving: true });
		expect(wrapper.get('[data-testid="draft-diff-apply"]').attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="draft-diff-discard"]').attributes('disabled')).toBeDefined();
	});

	// Piece D1': the inline Save (save-without-approving) beside Save & Approve.
	describe('inline Save', () => {
		it('is absent unless the surface opts in via showSave', () => {
			const wrapper = mountEditor({ original: 'Original', modelValue: 'Edited' });
			expect(wrapper.find('[data-testid="draft-diff-save"]').exists()).toBe(false);
		});

		it('emits save (and not apply) so the parent persists WITHOUT approving', async () => {
			const wrapper = mountEditor({ original: 'Original', modelValue: 'Edited', showSave: true });
			await wrapper.get('[data-testid="draft-diff-save"]').trigger('click');
			expect(wrapper.emitted('save')).toHaveLength(1);
			expect(wrapper.emitted('apply')).toBeUndefined();
		});

		it('stays enabled during a collision soft-hold — saving never sends', () => {
			const wrapper = mountEditor({
				original: 'Original',
				modelValue: 'Edited',
				held: true,
				showSave: true,
			});
			expect(wrapper.get('[data-testid="draft-diff-apply"]').attributes('disabled')).toBeDefined();
			expect(wrapper.get('[data-testid="draft-diff-save"]').attributes('disabled')).toBeUndefined();
		});
	});
});
