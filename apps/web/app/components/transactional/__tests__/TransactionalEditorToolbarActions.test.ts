// @vitest-environment happy-dom
/**
 * Publishing a transactional email renders its HTML from the canvas, so with
 * unsaved edits it would put content live that the saved email does not hold.
 * Like the template editor, the toolbar holds Publish until the edits are
 * saved, and says why. Unpublish stays available: a published email refuses
 * saves, so holding Unpublish too would leave the edits with no way out.
 *
 * "Says why" has to reach a keyboard or screen-reader user too, so a held
 * control stays in the tab order (`aria-disabled`, not `disabled`) and carries
 * the reason as its accessible description. The real UiButton is mounted: it
 * is what turns a `disabled` prop into a native, unfocusable `disabled`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';
import UiButton from '@owlat/ui/components/ui/Button.vue';

import TransactionalEditorToolbarActions from '../TransactionalEditorToolbarActions.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

let wrapper: VueWrapper | undefined;

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
});

function mountToolbar(props: {
	hasChanges: boolean;
	isPublished?: boolean;
	isPendingReview?: boolean;
}) {
	wrapper = mount(TransactionalEditorToolbarActions, {
		attachTo: document.body,
		props: {
			emailId: 'email_1' as Id<'transactionalEmails'>,
			isPublished: props.isPublished ?? false,
			isPendingReview: props.isPendingReview ?? false,
			isPublishing: false,
			hasChanges: props.hasChanges,
		},
		global: {
			plugins: [createTestI18n()],
			components: { UiButton },
			stubs: { ShareLinksPopover: true, Icon: true },
		},
	});
	return wrapper;
}

const publishButton = (w: VueWrapper, label: string) =>
	w.findAll('button').find((b) => b.text() === label)!;

/** The accessible description: the text of every `aria-describedby` target. */
function describedBy(el: HTMLElement): string {
	return (el.getAttribute('aria-describedby') ?? '')
		.split(/\s+/)
		.filter(Boolean)
		.map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
		.join(' ');
}

describe('TransactionalEditorToolbarActions — publish while dirty', () => {
	it('holds Publish with unsaved changes, focusable, with the save-first reason as its description', async () => {
		const w = mountToolbar({ hasChanges: true });
		const button = publishButton(w, 'Publish');
		const el = button.element as HTMLButtonElement;

		expect(el.disabled).toBe(false);
		expect(button.attributes('aria-disabled')).toBe('true');
		el.focus();
		expect(document.activeElement).toBe(el);
		expect(describedBy(el)).toBe('Save your changes before publishing');

		await button.trigger('click');
		await button.trigger('keydown', { key: 'Enter' });
		expect(w.emitted('toggle-publish')).toBeUndefined();
		expectFullyLocalized(w);
	});

	it('fades a held control without `opacity`, which would fade its focus ring too', () => {
		const held = publishButton(mountToolbar({ hasChanges: true }), 'Publish');
		expect(held.classes().some((c) => c.startsWith('opacity-'))).toBe(false);
		wrapper!.unmount();

		const pending = publishButton(
			mountToolbar({ hasChanges: false, isPendingReview: true }),
			'Awaiting review'
		);
		expect(pending.classes().some((c) => c.startsWith('opacity-'))).toBe(false);
	});

	it('keeps Unpublish enabled with unsaved changes, so the edits can be saved after it', async () => {
		const w = mountToolbar({ hasChanges: true, isPublished: true });
		const button = publishButton(w, 'Unpublish');

		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('aria-disabled')).toBeUndefined();
		expect(button.attributes('aria-describedby')).toBeUndefined();
		expect(button.attributes('title')).toBe('Return this email to draft (stops new sends)');
		await button.trigger('click');
		expect(w.emitted('toggle-publish')).toHaveLength(1);
	});

	it('enables Publish once the edits are saved, with no unavailable reason left behind', async () => {
		const w = mountToolbar({ hasChanges: false });
		const button = publishButton(w, 'Publish');

		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('aria-disabled')).toBeUndefined();
		expect(button.attributes('aria-describedby')).toBeUndefined();
		expect(w.find('.sr-only[id]').exists()).toBe(false);
		expect(button.attributes('title')).toBe('Publish this email to make it sendable via the API');
		await button.trigger('click');
		expect(w.emitted('toggle-publish')).toHaveLength(1);
	});

	it('drops the held state as soon as the edits are saved', async () => {
		const w = mountToolbar({ hasChanges: true });
		await w.setProps({ hasChanges: false });
		const button = publishButton(w, 'Publish');

		expect(button.attributes('aria-disabled')).toBeUndefined();
		await button.trigger('click');
		expect(w.emitted('toggle-publish')).toHaveLength(1);
	});
});

describe('TransactionalEditorToolbarActions — awaiting review', () => {
	it('is focusable and describes why there is nothing to do', async () => {
		const w = mountToolbar({ hasChanges: false, isPendingReview: true });
		const button = publishButton(w, 'Awaiting review');
		const el = button.element as HTMLButtonElement;

		expect(el.disabled).toBe(false);
		expect(button.attributes('aria-disabled')).toBe('true');
		el.focus();
		expect(document.activeElement).toBe(el);
		expect(describedBy(el)).toBe(
			'Flagged by the content scanner — an admin must approve this email before it can be sent.'
		);

		await button.trigger('click');
		expect(w.emitted('toggle-publish')).toBeUndefined();
		expect(publishButton(w, 'Publish')).toBeUndefined();
		expectFullyLocalized(w);
	});
});
