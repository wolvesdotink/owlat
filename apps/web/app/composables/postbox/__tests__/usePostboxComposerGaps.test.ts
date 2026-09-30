// @vitest-environment happy-dom
/**
 * An AI draft's `[[...]]` gaps (composables/postbox/usePostboxComposerGaps):
 *   - counted in what was written only (a quoted `[[...]]` is someone else's);
 *   - found as ranges in the editor's text, the quote left out, for the paint;
 *   - a click inside one selects all of it, so typing replaces it.
 */
import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';

import { gapAtCaret, gapRangesIn, usePostboxComposerGaps } from '../usePostboxComposerGaps';

function editorWith(html: string): HTMLElement {
	const root = document.createElement('div');
	root.innerHTML = `<div contenteditable="true">${html}</div>`;
	document.body.appendChild(root);
	return root;
}

describe('gapRangesIn', () => {
	it('finds each placeholder in the written text and none in the quote', () => {
		const root = editorWith(
			'<p>Hi, [[attach the invoice]] and [[the PO]].</p>' +
				'<div class="gmail_quote"><blockquote>[[theirs]]</blockquote></div>'
		);
		const editor = root.querySelector<HTMLElement>('[contenteditable]')!;
		expect(gapRangesIn(editor).map((r) => r.toString())).toEqual([
			'[[attach the invoice]]',
			'[[the PO]]',
		]);
		root.remove();
	});
});

describe('gapAtCaret', () => {
	it('returns the placeholder around a caret, edges included', () => {
		const text = document.createTextNode('Send [[the PO]] today');
		expect(gapAtCaret(text, 8)).toEqual({ start: 5, end: 15 });
		expect(gapAtCaret(text, 5)).toEqual({ start: 5, end: 15 });
		expect(gapAtCaret(text, 15)).toEqual({ start: 5, end: 15 });
		expect(gapAtCaret(text, 2)).toBeNull();
		expect(gapAtCaret(document.createElement('p'), 0)).toBeNull();
	});
});

describe('usePostboxComposerGaps', () => {
	it('counts the gaps left in what was written', async () => {
		const bodyHtml = ref('<p>[[the PO]]</p><div class="gmail_quote">[[quoted]]</div>');
		let gaps!: ReturnType<typeof usePostboxComposerGaps>;
		const Host = defineComponent({
			setup() {
				const rootEl = ref<HTMLElement | null>(null);
				gaps = usePostboxComposerGaps({ rootEl, bodyHtml });
				return () => h('div', { ref: rootEl }, [h('div', { contenteditable: 'true' })]);
			},
		});
		mount(Host);
		expect(gaps.gapCount.value).toBe(1);
		bodyHtml.value = '<p>All filled in.</p>';
		await nextTick();
		expect(gaps.gapCount.value).toBe(0);
	});

	it('selects the whole placeholder when the caret lands inside it', async () => {
		const bodyHtml = ref('<p>Send [[the PO]] today</p>');
		const Host = defineComponent({
			setup() {
				const rootEl = ref<HTMLElement | null>(null);
				usePostboxComposerGaps({ rootEl, bodyHtml });
				return () =>
					h('div', { ref: rootEl }, [
						h('div', { contenteditable: 'true', innerHTML: bodyHtml.value }),
					]);
			},
		});
		const w = mount(Host, { attachTo: document.body });
		const text = w.element.querySelector('p')!.firstChild!;
		const selection = document.getSelection()!;
		selection.collapse(text, 9);
		w.element.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(selection.toString()).toBe('[[the PO]]');
		w.unmount();
	});
});
