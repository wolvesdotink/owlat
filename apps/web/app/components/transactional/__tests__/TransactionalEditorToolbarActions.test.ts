// @vitest-environment happy-dom
/**
 * Publishing a transactional email renders its HTML from the canvas, so with
 * unsaved edits it would put content live that the saved email does not hold.
 * Like the template editor, the toolbar holds Publish until the edits are
 * saved, and says why. Unpublish stays available: a published email refuses
 * saves, so holding Unpublish too would leave the edits with no way out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';

import TransactionalEditorToolbarActions from '../TransactionalEditorToolbarActions.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const buttonStub = {
	props: ['loading', 'disabled', 'variant', 'title'],
	emits: ['click'],
	template:
		'<button :disabled="disabled || loading" :title="title" @click="$emit(\'click\')"><slot /></button>',
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountToolbar(props: { hasChanges: boolean; isPublished?: boolean }) {
	return mount(TransactionalEditorToolbarActions, {
		props: {
			emailId: 'email_1' as Id<'transactionalEmails'>,
			isPublished: props.isPublished ?? false,
			isPendingReview: false,
			isPublishing: false,
			hasChanges: props.hasChanges,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { UiButton: buttonStub, ShareLinksPopover: true, Icon: true },
		},
	});
}

const publishButton = (wrapper: ReturnType<typeof mountToolbar>, label: string) =>
	wrapper.findAll('button').find((b) => b.text() === label)!;

describe('TransactionalEditorToolbarActions — publish while dirty', () => {
	it('disables Publish with unsaved changes and says to save first', async () => {
		const wrapper = mountToolbar({ hasChanges: true });
		const button = publishButton(wrapper, 'Publish');

		expect(button.attributes('disabled')).toBeDefined();
		expect(button.attributes('title')).toBe('Save your changes before publishing');
		await button.trigger('click');
		expect(wrapper.emitted('toggle-publish')).toBeUndefined();
		expectFullyLocalized(wrapper);
	});

	it('keeps Unpublish enabled with unsaved changes, so the edits can be saved after it', async () => {
		const wrapper = mountToolbar({ hasChanges: true, isPublished: true });
		const button = publishButton(wrapper, 'Unpublish');

		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('title')).toBe('Return this email to draft (stops new sends)');
		await button.trigger('click');
		expect(wrapper.emitted('toggle-publish')).toHaveLength(1);
	});

	it('enables Publish once the edits are saved', async () => {
		const wrapper = mountToolbar({ hasChanges: false });
		const button = publishButton(wrapper, 'Publish');

		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('title')).toBe('Publish this email to make it sendable via the API');
		await button.trigger('click');
		expect(wrapper.emitted('toggle-publish')).toHaveLength(1);
	});
});
