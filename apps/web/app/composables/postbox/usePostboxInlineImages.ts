/**
 * Inline-image paste/drop handling for the Postbox basic editor.
 *
 * Pasting or dropping an image INTO the contenteditable body inserts a visible
 * `<img src="blob:…" data-inline-cid="X">` at the caret; the bytes upload through
 * the composer's attachment path (marked as an inline part with a Content-ID),
 * and the send path later rewrites the `blob:` src to `cid:<contentId>`.
 *
 * Deleting the image from the body (select + Backspace) drops the pending inline
 * part: `reconcile()` diffs the tracked content-IDs against what's still in the
 * DOM and calls `onRemoveEmbeddedImage` for any that vanished.
 *
 * This DOM-heavy concern lives here (rather than inline in `PostboxBasicEditor.vue`)
 * so the editor component stays under the file-size ratchet and the caret
 * insertion / reconcile logic can be reasoned about in isolation.
 */
import type { Ref } from 'vue';

export interface InlineImagesOptions {
	editorRef: Ref<HTMLElement | null>;
	/** True when pasting/dropping images should embed inline (off for signatures). */
	enabled: () => boolean;
	/** Upload an image → contentId + ephemeral preview URL to insert, or null on failure. */
	embedImage: () => ((file: File) => Promise<{ contentId: string; previewUrl: string } | null>) | undefined;
	/** Called with the contentId of an inline image removed from the body. */
	onRemoveEmbeddedImage: () => ((contentId: string) => void) | undefined;
	/** Re-emit + re-sync the draft after an insertion. */
	emitContent: () => void;
}

export function usePostboxInlineImages(opts: InlineImagesOptions) {
	// Tracks which inline content-IDs currently live in the editor so a deletion
	// (the user selects the <img> and hits Backspace) can drop the pending part.
	const knownInlineCids = new Set<string>();

	function active(): boolean {
		return opts.enabled() && !!opts.embedImage();
	}

	function imageFilesFrom(list: FileList | File[] | null | undefined): File[] {
		return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
	}

	function insertImageAtCaret(previewUrl: string, contentId: string) {
		const el = opts.editorRef.value;
		if (!el) return;
		const img = document.createElement('img');
		img.src = previewUrl;
		img.setAttribute('data-inline-cid', contentId);
		img.style.maxWidth = '100%';
		img.style.height = 'auto';
		const sel = window.getSelection();
		let range: Range;
		if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
			range = sel.getRangeAt(0);
			range.deleteContents();
		} else {
			range = document.createRange();
			range.selectNodeContents(el);
			range.collapse(false);
		}
		range.insertNode(img);
		range.setStartAfter(img);
		range.collapse(true);
		sel?.removeAllRanges();
		sel?.addRange(range);
		knownInlineCids.add(contentId);
		opts.emitContent();
	}

	async function embedImageFiles(files: File[]) {
		const embed = opts.embedImage();
		if (!opts.enabled() || !embed) return;
		for (const file of files) {
			const result = await embed(file);
			if (result) insertImageAtCaret(result.previewUrl, result.contentId);
		}
	}

	/**
	 * Diff the tracked inline cids against what's still in the DOM; any that
	 * vanished (image deleted from the body) drop their pending part.
	 */
	function reconcile() {
		if (!opts.enabled() || knownInlineCids.size === 0) return;
		const el = opts.editorRef.value;
		const present = new Set<string>();
		if (el) {
			el.querySelectorAll('img[data-inline-cid]').forEach((node) => {
				const cid = node.getAttribute('data-inline-cid');
				if (cid) present.add(cid);
			});
		}
		const onRemove = opts.onRemoveEmbeddedImage();
		for (const cid of [...knownInlineCids]) {
			if (!present.has(cid)) {
				knownInlineCids.delete(cid);
				onRemove?.(cid);
			}
		}
	}

	/**
	 * Handle a paste: if inline images are enabled and the clipboard carries
	 * image files, embed them and return true (caller should not paste text).
	 */
	function handlePaste(event: ClipboardEvent): boolean {
		if (!active()) return false;
		const images = imageFilesFrom(event.clipboardData?.files);
		if (images.length === 0) return false;
		event.preventDefault();
		event.stopPropagation();
		void embedImageFiles(images);
		return true;
	}

	/**
	 * Handle a drop: if inline images are enabled and the drop carries image
	 * files, embed them (stopping the composer's drop-to-attach handler) and
	 * return true. Non-image drops return false and fall through to attach.
	 */
	function handleDrop(event: DragEvent): boolean {
		if (!active()) return false;
		const images = imageFilesFrom(event.dataTransfer?.files);
		if (images.length === 0) return false;
		event.preventDefault();
		event.stopPropagation();
		void embedImageFiles(images);
		return true;
	}

	return { handlePaste, handleDrop, reconcile };
}
