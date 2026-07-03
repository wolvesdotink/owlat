// @vitest-environment happy-dom
/**
 * Inline-image paste/drop/reconcile behavior for the basic editor. These are the
 * spec behaviors: an image paste/drop embeds a <img data-inline-cid> at the caret
 * via the injected upload callback; a non-image paste/drop is left for the
 * caller's fallback; and deleting an embedded image from the DOM prunes its
 * pending part on the next reconcile.
 *
 * The composable uses no lifecycle hooks, so it can be driven directly with a
 * plain ref pointing at a contenteditable in happy-dom.
 */
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { usePostboxInlineImages } from '../usePostboxInlineImages';

function imageFile(name = 'a.png'): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

function setup(overrides: Partial<Parameters<typeof usePostboxInlineImages>[0]> = {}) {
	const el = document.createElement('div');
	el.contentEditable = 'true';
	document.body.appendChild(el);
	const editorRef = ref<HTMLElement | null>(el);
	const embed = vi.fn(async (f: File) => ({ contentId: `cid-${f.name}`, previewUrl: `blob:${f.name}` }));
	const onRemove = vi.fn();
	const emitContent = vi.fn();
	const api = usePostboxInlineImages({
		editorRef,
		enabled: () => true,
		embedImage: () => embed,
		onRemoveEmbeddedImage: () => onRemove,
		emitContent,
		...overrides,
	});
	return { el, editorRef, embed, onRemove, emitContent, api };
}

describe('usePostboxInlineImages', () => {
	it('embeds a pasted image as <img data-inline-cid> and consumes the event', async () => {
		const { el, embed, emitContent, api } = setup();
		const event = {
			clipboardData: { files: [imageFile('shot.png')] },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as ClipboardEvent;

		const consumed = api.handlePaste(event);
		expect(consumed).toBe(true);
		expect(event.preventDefault).toHaveBeenCalled();
		await Promise.resolve();
		await Promise.resolve();

		const img = el.querySelector('img[data-inline-cid]');
		expect(img).not.toBeNull();
		expect(img?.getAttribute('data-inline-cid')).toBe('cid-shot.png');
		expect(img?.getAttribute('src')).toBe('blob:shot.png');
		expect(embed).toHaveBeenCalledOnce();
		expect(emitContent).toHaveBeenCalled();
	});

	it('leaves a non-image paste for the caller (returns false, no embed)', () => {
		const { embed, api } = setup();
		const event = {
			clipboardData: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as ClipboardEvent;
		expect(api.handlePaste(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(embed).not.toHaveBeenCalled();
	});

	it('embeds an image drop and consumes it; leaves a non-image drop to attach', async () => {
		const { el, api } = setup();
		const imgEvent = {
			dataTransfer: { files: [imageFile('drop.png')] },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as DragEvent;
		expect(api.handleDrop(imgEvent)).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(el.querySelector('img[data-inline-cid]')).not.toBeNull();

		const fileEvent = {
			dataTransfer: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as DragEvent;
		expect(api.handleDrop(fileEvent)).toBe(false);
		expect(fileEvent.preventDefault).not.toHaveBeenCalled();
	});

	it('does nothing when disabled', () => {
		const { embed, api } = setup({ enabled: () => false });
		const event = {
			clipboardData: { files: [imageFile()] },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as ClipboardEvent;
		expect(api.handlePaste(event)).toBe(false);
		expect(embed).not.toHaveBeenCalled();
	});

	it('reconcile prunes the pending part when its <img> is removed from the DOM', async () => {
		const { el, onRemove, api } = setup();
		const event = {
			clipboardData: { files: [imageFile('keep.png')] },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as ClipboardEvent;
		api.handlePaste(event);
		await Promise.resolve();
		await Promise.resolve();
		expect(el.querySelector('img[data-inline-cid]')).not.toBeNull();

		// Still present → no prune.
		api.reconcile();
		expect(onRemove).not.toHaveBeenCalled();

		// User deletes the image from the body.
		el.querySelector('img[data-inline-cid]')?.remove();
		api.reconcile();
		expect(onRemove).toHaveBeenCalledWith('cid-keep.png');

		// Idempotent — the cid is no longer tracked.
		onRemove.mockClear();
		api.reconcile();
		expect(onRemove).not.toHaveBeenCalled();
	});
});
