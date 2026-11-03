/**
 * The template editor's Publish / Unpublish button. Publish puts the stored
 * HTML live, so it waits for unsaved edits to be saved. Unpublish must not:
 * the backend refuses to save a published template, so holding Unpublish
 * while dirty left the edits with no way to be saved or published.
 *
 * The reason Publish is held has to reach a keyboard or screen-reader user
 * too, so a held Publish stays in the tab order (`aria-disabled`, not
 * `disabled`) and carries the reason as its accessible description. The real
 * UiButton is mounted: it is what turns a `disabled` prop into a native,
 * unfocusable `disabled`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import UiButton from '@owlat/ui/components/ui/Button.vue';

import TemplatePublishButton from '../TemplatePublishButton.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { tooltipOf } from '~/__tests__/tooltip';

let wrapper: VueWrapper | undefined;

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
});

function mountButton(props: {
	isPublished: boolean;
	hasChanges: boolean;
	hasStoredHtml?: boolean;
	loading?: boolean;
}) {
	wrapper = mount(TemplatePublishButton, {
		attachTo: document.body,
		props: { hasStoredHtml: true, loading: false, ...props },
		global: {
			plugins: [createTestI18n()],
			components: { UiButton },
		},
	});
	return wrapper;
}

/** The accessible description: the text of every `aria-describedby` target. */
function describedBy(el: HTMLElement): string {
	return (el.getAttribute('aria-describedby') ?? '')
		.split(/\s+/)
		.filter(Boolean)
		.map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
		.join(' ');
}

describe('TemplatePublishButton — held Publish', () => {
	it.each([
		{
			why: 'unsaved changes',
			props: { isPublished: false, hasChanges: true },
			reason: 'Save your changes before publishing',
		},
		{
			why: 'no stored HTML yet',
			props: { isPublished: false, hasChanges: false, hasStoredHtml: false },
			reason: 'Save the email before publishing it',
		},
	])(
		'holds Publish with $why, focusable, with the save-first reason as its description',
		async ({ props, reason }) => {
			const w = mountButton(props);
			const button = w.get('button');
			const el = button.element as HTMLButtonElement;

			expect(button.text()).toBe('Publish');
			expect(el.disabled).toBe(false);
			expect(button.attributes('aria-disabled')).toBe('true');
			// Focus opens the tooltip with the same reason; it is not read twice.
			el.focus();
			expect(document.activeElement).toBe(el);
			expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(reason);
			expect(describedBy(el)).toBe(reason);
			expect(tooltipOf(w, button)).toBe(reason);
			expect(button.attributes('title')).toBeUndefined();

			await button.trigger('click');
			await button.trigger('keydown', { key: 'Enter' });
			expect(w.emitted('toggle')).toBeUndefined();
			expectFullyLocalized(w);
		}
	);

	it('fades a held Publish without `opacity`, which would fade its focus ring too', () => {
		const button = mountButton({ isPublished: false, hasChanges: true }).get('button');

		expect(button.classes()).toContain('cursor-not-allowed');
		expect(button.classes().some((c) => c.startsWith('opacity-'))).toBe(false);
	});

	it('drops the held state as soon as the edits are saved', async () => {
		const w = mountButton({ isPublished: false, hasChanges: true });
		await w.setProps({ hasChanges: false });
		const button = w.get('button');

		expect(button.attributes('aria-disabled')).toBeUndefined();
		expect(button.attributes('aria-describedby')).toBeUndefined();
		expect(w.find('.sr-only[id]').exists()).toBe(false);
		await button.trigger('click');
		expect(w.emitted('toggle')).toHaveLength(1);
	});
});

describe('TemplatePublishButton — live controls', () => {
	it('keeps Unpublish enabled with unsaved changes', async () => {
		const w = mountButton({ isPublished: true, hasChanges: true });
		const button = w.get('button');

		expect(button.text()).toBe('Unpublish');
		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('aria-disabled')).toBeUndefined();
		expect(button.attributes('aria-describedby')).toBeUndefined();
		expect(tooltipOf(w, button)).toBeUndefined();
		expect(button.attributes('title')).toBeUndefined();
		await button.trigger('click');
		expect(w.emitted('toggle')).toHaveLength(1);
	});

	it('enables Publish on a saved email, with no held reason', async () => {
		const w = mountButton({ isPublished: false, hasChanges: false });
		const button = w.get('button');

		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('aria-disabled')).toBeUndefined();
		expect(button.attributes('aria-describedby')).toBeUndefined();
		expect(tooltipOf(w, button)).toBeUndefined();
		expect(button.attributes('title')).toBeUndefined();
		expect(w.find('.sr-only[id]').exists()).toBe(false);
		await button.trigger('click');
		expect(w.emitted('toggle')).toHaveLength(1);
	});

	it('blocks activation while a publish/unpublish is in flight', async () => {
		const w = mountButton({ isPublished: false, hasChanges: false, loading: true });
		const button = w.get('button');

		expect((button.element as HTMLButtonElement).disabled).toBe(true);
		await button.trigger('click');
		expect(w.emitted('toggle')).toBeUndefined();
	});
});
