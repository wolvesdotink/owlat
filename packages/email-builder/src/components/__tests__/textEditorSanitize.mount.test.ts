// @vitest-environment happy-dom
//
// Both text editors write stored block HTML into a live contenteditable in the
// editor document. They run it through the shared editor sanitizer first, on
// mount and (for the sidebar editor) when the value prop changes, and every
// commit path emits sanitized HTML.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import RichTextEditor from '../panel/RichTextEditor.vue';
import InlineTextEditor from '../canvas/InlineTextEditor.vue';
import { defaultTheme } from '../../defaults';
import type { EditorBlock, EmailTheme } from '../../types';

const UNSAFE_IMG = '<p>Hi</p><img src="x" onerror="window.__x=1">';
const UNSAFE_LINK = '<a href="javascript:alert(1)">x</a>';

const LEGITIMATE =
	'<p><strong>Bold</strong> <em>italic</em> <b>b</b> <i>i</i> <u>u</u> ' +
	'<a href="https://example.com" target="_blank" rel="noopener">link</a> ' +
	'<span style="color: #ff0000">red</span></p>' +
	'<ul><li>one</li><li>two</li></ul>';

declare global {
	interface Window {
		__x?: number;
	}
}

let wrappers: VueWrapper[] = [];
beforeEach(() => {
	delete window.__x;
});
afterEach(() => {
	for (const w of wrappers) w.unmount();
	wrappers = [];
	document.body.innerHTML = '';
});

function textBlock(html: string): EditorBlock {
	return {
		id: 'b1',
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#000' },
	};
}

function mountRich(value: string) {
	const w = mount(RichTextEditor, { props: { value }, attachTo: document.body });
	wrappers.push(w);
	return w;
}

function mountInline(html: string) {
	const w = mount(InlineTextEditor, {
		props: { block: textBlock(html), theme: defaultTheme as Required<EmailTheme> },
		attachTo: document.body,
	});
	wrappers.push(w);
	return w;
}

const richEditor = (w: VueWrapper) => w.get<HTMLDivElement>('[contenteditable="true"]').element;
const inlineEditor = (w: VueWrapper) => w.get<HTMLElement>('[contenteditable="true"]').element;

function expectNoActiveContent(el: HTMLElement) {
	expect(el.querySelector('[onerror]')).toBeNull();
	expect(el.innerHTML).not.toContain('onerror');
	expect(el.innerHTML).not.toContain('javascript:');
	expect(window.__x).toBeUndefined();
}

describe('RichTextEditor — sanitizes stored HTML on load', () => {
	it('drops event handlers from the initial value', async () => {
		const w = mountRich(UNSAFE_IMG);
		await nextTick();
		expectNoActiveContent(richEditor(w));
		expect(richEditor(w).textContent).toContain('Hi');
	});

	it('drops event handlers when the value prop changes', async () => {
		const w = mountRich('<p>safe</p>');
		await w.setProps({ value: UNSAFE_IMG });
		await nextTick();
		expectNoActiveContent(richEditor(w));
	});

	it('drops javascript: links from the loaded value', async () => {
		const w = mountRich(UNSAFE_LINK);
		await nextTick();
		expectNoActiveContent(richEditor(w));
	});

	it('keeps legitimate formatting on load', async () => {
		const w = mountRich(LEGITIMATE);
		await nextTick();
		const el = richEditor(w);
		expect(el.querySelector('strong')?.textContent).toBe('Bold');
		expect(el.querySelector('em')?.textContent).toBe('italic');
		expect(el.querySelector('u')?.textContent).toBe('u');
		expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
		expect(el.querySelectorAll('li')).toHaveLength(2);
		expect(el.querySelector('span')?.getAttribute('style')).toContain('color');
	});

	it('emits sanitized HTML when the visual editor changes', async () => {
		const w = mountRich('<p>x</p>');
		await nextTick();
		richEditor(w).innerHTML = UNSAFE_LINK;
		await w.get('[contenteditable="true"]').trigger('input');
		const emitted = w.emitted('update')?.at(-1)?.[0] as string;
		expect(emitted).toContain('x');
		expect(emitted).not.toContain('javascript:');
	});

	it('emits sanitized HTML from source mode', async () => {
		const w = mountRich('<p>x</p>');
		await w.get('button[aria-label="Source mode"]').trigger('click');
		const textarea = w.get('textarea');
		(textarea.element as HTMLTextAreaElement).value = UNSAFE_LINK;
		await textarea.trigger('input');
		const emitted = w.emitted('update')?.at(-1)?.[0] as string;
		expect(emitted).not.toContain('javascript:');
	});

	it('leaves the live editor alone when its own value echoes back', async () => {
		const w = mountRich('<p>x</p>');
		await nextTick();
		const el = richEditor(w);
		el.innerHTML = '<p>a<br>b <span style="color: red">c</span></p>';
		const paragraph = el.firstChild;
		await w.get('[contenteditable="true"]').trigger('input');
		const emitted = w.emitted('update')?.at(-1)?.[0] as string;
		await w.setProps({ value: emitted });
		await nextTick();
		expect(el.firstChild).toBe(paragraph);
	});

	it('applies an outside value that repeats an earlier emit', async () => {
		const w = mountRich('<p>x</p>');
		await nextTick();
		richEditor(w).innerHTML = '<p>typed</p>';
		await w.get('[contenteditable="true"]').trigger('input');
		const emitted = w.emitted('update')?.at(-1)?.[0] as string;
		await w.setProps({ value: emitted });
		await w.setProps({ value: '<p>x</p>' });
		await w.setProps({ value: emitted });
		await nextTick();
		expect(richEditor(w).innerHTML).toBe('<p>typed</p>');
	});

	it('keeps variable chips intact through a commit', async () => {
		const chip =
			'<p>Hi <span class="variable-tag" contenteditable="false" data-variable="firstName">{{firstName}}</span></p>';
		const w = mountRich(chip);
		await nextTick();
		await w.get('[contenteditable="true"]').trigger('input');
		const emitted = w.emitted('update')?.at(-1)?.[0] as string;
		expect(emitted).toContain('data-variable="firstName"');
		expect(emitted).toContain('contenteditable="false"');
		expect(emitted).toContain('class="variable-tag"');
	});
});

describe('InlineTextEditor — sanitizes stored HTML on load', () => {
	it('drops event handlers from the block HTML', async () => {
		const w = mountInline(UNSAFE_IMG);
		await nextTick();
		expectNoActiveContent(inlineEditor(w));
		expect(inlineEditor(w).textContent).toContain('Hi');
	});

	it('drops event handlers after a block prop update', async () => {
		const w = mountInline('<p>safe</p>');
		await w.setProps({ block: textBlock(UNSAFE_IMG) });
		await nextTick();
		expectNoActiveContent(inlineEditor(w));
	});

	it('drops javascript: links from the block HTML', async () => {
		const w = mountInline(UNSAFE_LINK);
		await nextTick();
		expectNoActiveContent(inlineEditor(w));
	});

	it('keeps legitimate formatting on load', async () => {
		const w = mountInline(LEGITIMATE);
		await nextTick();
		const el = inlineEditor(w);
		expect(el.querySelector('strong')?.textContent).toBe('Bold');
		expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
		expect(el.querySelectorAll('li')).toHaveLength(2);
		expect(el.querySelector('span')?.getAttribute('style')).toContain('color');
	});
});
