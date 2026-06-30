// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { computed } from 'vue';
import { useInlineTextEdit } from '../useInlineTextEdit';
import type { EditorBlock } from '../../types';

function textBlock(id: string, html: string): EditorBlock {
	return {
		id,
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#000' },
	};
}

/**
 * Belt-and-suspenders sanitization on save (P0-1): contenteditable output is
 * scrubbed in `exitInlineEdit` before it is persisted, so a pasted
 * `<img onerror=…>` / `<script>` never reaches storage. (The renderer
 * sanitizes again at the email boundary; the in-canvas preview sanitizes on
 * read.)
 */
describe('useInlineTextEdit.exitInlineEdit — sanitizes before save', () => {
	function setup(initialHtml: string, editorHtml: string) {
		const block = textBlock('b1', initialHtml);
		const activeBlock = computed<EditorBlock | null>(() => block);
		const onUpdate = vi.fn();
		const onDeleteBlock = vi.fn();

		const edit = useInlineTextEdit({ activeBlock, onUpdate, onDeleteBlock });
		edit.enterInlineEdit('b1');

		const el = document.createElement('div');
		el.innerHTML = editorHtml;
		edit.inlineEditorRef.value = { el };

		return { edit, onUpdate, onDeleteBlock, el };
	}

	it('strips event-handler attributes (onerror) from saved HTML', () => {
		const { edit, onUpdate } = setup('<p>x</p>', '<p>hi</p><img src="x" onerror="alert(1)">');
		edit.exitInlineEdit();

		expect(onUpdate).toHaveBeenCalledTimes(1);
		const savedHtml = onUpdate.mock.calls[0]![2] as string;
		expect(savedHtml).not.toContain('onerror');
		expect(savedHtml).not.toContain('alert(1)');
		expect(savedHtml).toContain('hi');
	});

	it('strips <script> from saved HTML', () => {
		const { edit, onUpdate } = setup('<p>x</p>', '<p>hi</p><script>alert(1)</script>');
		edit.exitInlineEdit();

		const savedHtml = onUpdate.mock.calls[0]![2] as string;
		expect(savedHtml).not.toContain('<script');
		expect(savedHtml).not.toContain('alert(1)');
	});

	it('preserves benign formatting and {{variable}} placeholders', () => {
		const { edit, onUpdate } = setup(
			'<p>x</p>',
			'<p><strong>Hi</strong> <span class="variable-tag" data-variable="firstName">{{firstName}}</span></p>',
		);
		edit.exitInlineEdit();

		const savedHtml = onUpdate.mock.calls[0]![2] as string;
		expect(savedHtml).toContain('<strong>Hi</strong>');
		expect(savedHtml).toContain('{{firstName}}');
		expect(savedHtml).toContain('variable-tag');
	});

	it('still auto-deletes empty blocks (sanitization does not change emptiness handling)', () => {
		const { edit, onUpdate, onDeleteBlock } = setup('<p>x</p>', '<br>');
		edit.exitInlineEdit();

		expect(onDeleteBlock).toHaveBeenCalledWith('b1');
		expect(onUpdate).not.toHaveBeenCalled();
	});
});
