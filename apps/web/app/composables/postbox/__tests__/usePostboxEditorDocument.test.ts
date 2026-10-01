// @vitest-environment happy-dom
/**
 * The contenteditable <-> `modelValue` mirror, and specifically which incoming
 * values are allowed to rewrite the DOM.
 *
 * Two failure modes pull in opposite directions:
 *
 *   - rewriting `innerHTML` on the parent's echo of what this editor just
 *     emitted drops the caret mid-keystroke;
 *   - refusing every write while the editor has focus silently loses edits that
 *     did not come from the keyboard. "Share as link instead" is the sharp
 *     case: it detaches the attachment server-side and appends a link block to
 *     the bound ref seconds later. If that block never reaches the DOM, the very
 *     next keystroke emits `el.innerHTML` over the top of it and the message
 *     goes out with neither the file nor the link.
 *
 * So the skip is by VALUE (an echo of our own emit), never by focus.
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { usePostboxEditorDocument } from '../usePostboxEditorDocument';
import { applySignatureToBody, wrapSignatureBlock } from '../usePostboxSignatureBody';
import { buildQuotedReply } from '../usePostboxQuotedText';

function setup(initial = '<p>Numbers attached.</p>') {
	const model = ref(initial);
	const emitted: string[] = [];
	const editorRef = ref<HTMLDivElement | null>(null);
	const readActiveMarks = vi.fn(() => ({}) as never);
	let doc!: ReturnType<typeof usePostboxEditorDocument>;

	const Host = defineComponent({
		setup() {
			doc = usePostboxEditorDocument({
				editorRef,
				modelValue: () => model.value,
				readActiveMarks,
				emit: (value) => {
					emitted.push(value);
					// The parent binds it straight back, as `v-model` does.
					model.value = value;
				},
			});
			return () => h('div', { ref: editorRef, contenteditable: 'true' });
		},
	});

	const wrapper = mount(Host, { attachTo: document.body });
	return { wrapper, model, emitted, el: () => editorRef.value!, doc: () => doc };
}

describe('usePostboxEditorDocument — incoming model writes', () => {
	it('mirrors the initial value into the element on mount', () => {
		const { el } = setup();
		expect(el().innerHTML).toBe('<p>Numbers attached.</p>');
	});

	it('applies an external append even while the editor has focus', async () => {
		const { el, model } = setup();
		el().focus();
		expect(document.activeElement).toBe(el());

		// What `shareAsLink` does once the server round-trip resolves.
		model.value = '<p>Numbers attached.</p><p><a href="https://x/s/abc">file.pdf</a></p>';
		await nextTick();

		expect(el().innerHTML).toContain('https://x/s/abc');
	});

	it('leaves the caret inside the editor after an external write', async () => {
		const { el, model } = setup();
		el().focus();

		model.value = '<p>Numbers attached.</p><p>appended</p>';
		await nextTick();

		const selection = window.getSelection();
		expect(selection?.rangeCount).toBe(1);
		expect(el().contains(selection!.getRangeAt(0).startContainer)).toBe(true);
		expect(selection!.getRangeAt(0).collapsed).toBe(true);
	});

	it('does not rewrite the DOM when the parent echoes back what was just emitted', async () => {
		const { el, model, doc } = setup();
		el().focus();

		// The user types: the DOM moves first, then emitContent tells the parent.
		el().innerHTML = '<p>Numbers attached and typed</p>';
		doc().emitContent();
		// Whatever the parent stores, the DOM stays the user's; assert on identity
		// so a re-assignment of the same string still counts as a rewrite.
		const before = el().firstChild;
		await nextTick();

		expect(model.value).toBe('<p>Numbers attached and typed</p>');
		expect(el().firstChild).toBe(before);
	});

	it('keeps a share block that lands mid-typing, so the next keystroke cannot erase it', async () => {
		const { el, model, doc } = setup();
		el().focus();

		// User types while the share request is in flight.
		el().innerHTML = '<p>Numbers attached, see below.</p>';
		doc().emitContent();
		await nextTick();

		// The share resolves and appends its block to the bound ref.
		model.value = `${model.value}<p><a href="https://x/s/abc">file.pdf</a></p>`;
		await nextTick();
		expect(el().innerHTML).toContain('https://x/s/abc');

		// Next keystroke: the editor emits its own DOM, which now HAS the block.
		el().innerHTML = `${el().innerHTML}<p>!</p>`;
		doc().emitContent();

		expect(model.value).toContain('https://x/s/abc');
	});

	it('still applies external writes when the editor is not focused', async () => {
		const { el, model } = setup();
		model.value = '<p>hydrated</p>';
		await nextTick();
		expect(el().innerHTML).toBe('<p>hydrated</p>');
	});

	it('scaffolds an empty paragraph when the model is cleared', async () => {
		const { el, model } = setup();
		model.value = '';
		await nextTick();
		expect(el().innerHTML).toBe('<p><br></p>');
	});
});

describe('usePostboxEditorDocument — sanitizing incoming values', () => {
	it('sanitizes the initial value before it reaches the element', () => {
		const { el } = setup('<p>Hi</p><img src="x" onerror="window.__x = 1"><script>1</script>');
		expect(el().innerHTML).not.toContain('onerror');
		expect(el().innerHTML).not.toContain('<script');
		expect(el().innerHTML).toContain('<p>Hi</p>');
	});

	it('sanitizes an external model write before it reaches the element', async () => {
		const { el, model } = setup();
		model.value = '<p>Draft</p><a href="javascript:void(0)" onclick="1">x</a>';
		await nextTick();
		expect(el().innerHTML).not.toContain('javascript:');
		expect(el().innerHTML).not.toContain('onclick');
		expect(el().innerHTML).toContain('<p>Draft</p>');
	});

	it('keeps the markup the editor itself produces', async () => {
		const { el, model } = setup();
		const own =
			'<p><a href="https://example.com" target="_blank" rel="noreferrer noopener">link</a></p>' +
			'<p><img src="blob:https://app.example/1234" data-inline-cid="img-1" style="max-width:100%;height:auto"></p>';
		model.value = own;
		await nextTick();
		expect(el().innerHTML).toContain('target="_blank"');
		expect(el().innerHTML).toContain('rel="noreferrer noopener"');
		expect(el().innerHTML).toContain('data-inline-cid="img-1"');
		expect(el().innerHTML).toContain('src="blob:https://app.example/1234"');
	});

	it('keeps the signature marker through mount and emit, so the picker swaps the block in place', () => {
		const { model, doc } = setup(`<p>Hello</p>${wrapSignatureBlock('<p>-- Ana</p>')}`);
		doc().emitContent();

		const swapped = applySignatureToBody(model.value, '<p>-- Team</p>');
		expect(swapped).toContain('-- Team');
		expect(swapped).not.toContain('-- Ana');
		expect(swapped.match(/data-postbox-signature/g)).toHaveLength(1);
		expect(applySignatureToBody(model.value, '')).not.toContain('-- Ana');
	});

	it('keeps the signature marker on an external model write', async () => {
		const { model, doc } = setup('<p>Hello</p>');
		model.value = `<p>Hello</p>${wrapSignatureBlock('<p>-- Ana</p>')}`;
		await nextTick();
		doc().emitContent();
		expect(applySignatureToBody(model.value, '<p>-- Team</p>')).not.toContain('-- Ana');
	});

	it('keeps the quoted-reply bar and plain-text wrapping', () => {
		const quoted = buildQuotedReply({
			fromAddress: 'ana@example.com',
			receivedAt: 0,
			textBodyInline: 'original',
		});
		const { el } = setup(`<p>Reply</p>${quoted}`);
		expect(el().innerHTML).toContain('border-left:1px solid #ccc');
		expect(el().innerHTML).toContain('white-space:pre-wrap');
	});
});

describe('usePostboxEditorDocument — emitting only what changed', () => {
	// A seed the browser serializes differently from the string it was given:
	// single-quoted attributes come back double-quoted. A reply's quote does the
	// same in a real browser, which is how a plain blur used to look like an edit.
	const RESERIALIZED = "<p class='lead'>Hello</p>";

	it('emits nothing when the editor is blurred without an edit (no draft row for it)', () => {
		const { el, emitted, doc } = setup(RESERIALIZED);
		expect(el().innerHTML).not.toBe(RESERIALIZED);

		// What onBlur does.
		doc().emitContent();

		expect(emitted).toEqual([]);
	});

	it('emits nothing after an external write the person never touched', async () => {
		const { emitted, model, doc } = setup();
		model.value = RESERIALIZED;
		await nextTick();

		doc().emitContent();

		expect(emitted).toEqual([]);
	});

	it('still emits an edit, and an edit that returns to the seed', () => {
		const { el, emitted, model, doc } = setup(RESERIALIZED);
		const seeded = el().innerHTML;

		el().innerHTML = '<p class="lead">Hello there</p>';
		doc().emitContent();
		el().innerHTML = seeded;
		doc().emitContent();

		expect(emitted).toEqual(['<p class="lead">Hello there</p>', seeded]);
		expect(model.value).toBe(seeded);
	});
});
