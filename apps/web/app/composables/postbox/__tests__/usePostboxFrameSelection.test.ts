/**
 * The selected passage of one message body's frame (usePostboxFrameSelection):
 * read from the frame's own document, quoted by the registry's reply key
 * pressed inside the frame, dropped with Escape, a click elsewhere, a new
 * document or the end of the component, and never offered where quoting is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { usePostboxFrameSelection } from '../usePostboxFrameSelection';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';

function frameDoc(html: string): Document {
	const doc = document.implementation.createHTMLDocument('');
	// A committed srcdoc document, not the frame's initial about:blank.
	Object.defineProperty(doc, 'URL', { configurable: true, value: 'about:srcdoc' });
	doc.body.innerHTML = html;
	return doc;
}

function makeFrame(initial: Document | null) {
	const iframe = document.createElement('iframe');
	let current = initial;
	Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => current });
	return {
		iframe,
		setDoc(doc: Document | null) {
			current = doc;
		},
	};
}

/** Select `text` inside the first matching text node, as a drag would. */
function select(doc: Document, text: string) {
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const at = node.data.indexOf(text);
		if (at < 0) continue;
		doc.getSelection()!.setBaseAndExtent(node, at, node, at + text.length);
		doc.dispatchEvent(new Event('selectionchange'));
		return;
	}
	throw new Error(`no "${text}" in the frame`);
}

function key(doc: Document, init: KeyboardEventInit) {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	doc.body.dispatchEvent(event);
	return event;
}

let scope: EffectScope;
/** The hand-built action buttons this file appended, removed after each test. */
const owned: HTMLElement[] = [];

function setup(doc: Document, opts: { enabled?: () => boolean } = {}) {
	const frame = makeFrame(doc);
	const iframeRef = ref<HTMLIFrameElement | null>(frame.iframe);
	const srcdoc = ref('<p>one</p>');
	const action = document.createElement('button');
	document.body.appendChild(action);
	owned.push(action);
	const onQuote = vi.fn();
	const focusAction = vi.fn();
	const api = scope.run(() =>
		usePostboxFrameSelection({
			iframeRef,
			srcdoc,
			enabled: opts.enabled ?? (() => true),
			onQuote,
			actionEl: () => action,
			focusAction,
		})
	)!;
	return { ...api, frame, iframeRef, srcdoc, action, onQuote, focusAction };
}

beforeEach(() => {
	scope = effectScope();
	resetShortcutPreferences();
});

afterEach(() => {
	scope.stop();
	for (const el of owned.splice(0)) el.remove();
	resetShortcutPreferences();
});

describe('usePostboxFrameSelection', () => {
	it('reads a selected passage from the frame document, and nothing for a collapsed one', async () => {
		const doc = frameDoc('<p>Hi there,</p><p>We were billed twice on the 14th.</p>');
		const { selection } = setup(doc);
		await nextTick();

		select(doc, 'billed twice');
		expect(selection.value?.text).toBe('billed twice');

		doc.getSelection()!.collapseToEnd();
		doc.dispatchEvent(new Event('selectionchange'));
		expect(selection.value).toBeNull();
	});

	it('offers nothing for whitespace, or where quoting is off', async () => {
		const doc = frameDoc('<p>a   b</p>');
		const enabled = ref(true);
		const { selection } = setup(doc, { enabled: () => enabled.value });
		await nextTick();

		select(doc, '   ');
		expect(selection.value).toBeNull();

		select(doc, 'a   b');
		expect(selection.value?.text).toBe('a   b');
		enabled.value = false;
		await nextTick();
		expect(selection.value).toBeNull();
	});

	it('quotes with the reply key pressed inside the frame, and leaves other keys alone', async () => {
		const doc = frameDoc('<p>Invoice 4471 &amp; 4472 are identical.</p>');
		const { onQuote } = setup(doc);
		await nextTick();

		// No selection: `r` is not this composable's to take.
		expect(key(doc, { key: 'r' }).defaultPrevented).toBe(false);
		expect(onQuote).not.toHaveBeenCalled();

		select(doc, '4471 & 4472');
		expect(key(doc, { key: 'e' }).defaultPrevented).toBe(false);
		expect(key(doc, { key: 'r', metaKey: true }).defaultPrevented).toBe(false);
		expect(onQuote).not.toHaveBeenCalled();

		expect(key(doc, { key: 'r' }).defaultPrevented).toBe(true);
		expect(onQuote).toHaveBeenCalledTimes(1);
		expect(onQuote).toHaveBeenCalledWith('4471 & 4472');
	});

	it('follows a remapped reply key', async () => {
		applyShortcutPreferences('owlat', [{ id: 'postbox.reply', keys: ['y'] }]);
		const doc = frameDoc('<p>Thursday works.</p>');
		const { onQuote } = setup(doc);
		await nextTick();
		select(doc, 'Thursday');

		key(doc, { key: 'r' });
		expect(onQuote).not.toHaveBeenCalled();
		key(doc, { key: 'y' });
		expect(onQuote).toHaveBeenCalledWith('Thursday');
	});

	it('lets go of the selection on Escape, and moves to the action on Tab', async () => {
		const doc = frameDoc('<p>Thursday works.</p>');
		const { selection, focusAction } = setup(doc);
		await nextTick();

		select(doc, 'Thursday');
		expect(key(doc, { key: 'Tab' }).defaultPrevented).toBe(true);
		expect(focusAction).toHaveBeenCalledTimes(1);
		expect(selection.value?.text).toBe('Thursday');

		expect(key(doc, { key: 'Escape' }).defaultPrevented).toBe(true);
		expect(selection.value).toBeNull();
		expect(doc.getSelection()!.isCollapsed || doc.getSelection()!.rangeCount === 0).toBe(true);
	});

	it('keeps the selection for a press on the action, and drops it for one elsewhere', async () => {
		const doc = frameDoc('<p>Thursday works.</p>');
		const { selection, action } = setup(doc);
		await nextTick();
		select(doc, 'Thursday');
		await nextTick();

		action.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(selection.value?.text).toBe('Thursday');

		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(selection.value).toBeNull();
	});

	it('keeps the selection while focus moves to the action, and drops it when focus goes elsewhere', async () => {
		const doc = frameDoc('<p>Thursday works.</p>');
		const { selection, action } = setup(doc);
		await nextTick();
		select(doc, 'Thursday');
		await nextTick();

		action.focus();
		expect(document.activeElement).toBe(action);
		expect(selection.value?.text).toBe('Thursday');

		const elsewhere = document.createElement('button');
		document.body.appendChild(elsewhere);
		owned.push(elsewhere);
		elsewhere.focus();
		expect(selection.value).toBeNull();
	});

	it('drops the selection and unbinds when the frame renders a new document', async () => {
		const first = frameDoc('<p>Old body</p>');
		const { selection, frame, srcdoc, onQuote } = setup(first);
		await nextTick();
		select(first, 'Old');
		expect(selection.value?.text).toBe('Old');

		srcdoc.value = '<p>New body</p>';
		await nextTick();
		expect(selection.value).toBeNull();
		// The outgoing document no longer reaches the reader.
		select(first, 'Old');
		key(first, { key: 'r' });
		expect(selection.value).toBeNull();
		expect(onQuote).not.toHaveBeenCalled();

		const next = frameDoc('<p>New body</p>');
		frame.setDoc(next);
		frame.iframe.dispatchEvent(new Event('load'));
		select(next, 'New');
		expect(selection.value?.text).toBe('New');
	});

	it('lets go of the document when the frame goes away or the component ends', async () => {
		const doc = frameDoc('<p>Thursday works.</p>');
		const { selection, iframeRef, onQuote } = setup(doc);
		await nextTick();
		select(doc, 'Thursday');

		iframeRef.value = null;
		await nextTick();
		expect(selection.value).toBeNull();
		key(doc, { key: 'r' });
		expect(onQuote).not.toHaveBeenCalled();

		const again = frameDoc('<p>Again</p>');
		iframeRef.value = makeFrame(again).iframe;
		await nextTick();
		scope.stop();
		select(again, 'Again');
		key(again, { key: 'r' });
		expect(onQuote).not.toHaveBeenCalled();
	});
});
