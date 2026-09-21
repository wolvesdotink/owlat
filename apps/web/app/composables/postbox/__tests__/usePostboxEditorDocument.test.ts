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
