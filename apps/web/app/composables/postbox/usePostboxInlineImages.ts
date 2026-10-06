/**
 * Inline-image paste/drop handling for the Postbox basic editor.
 *
 * Pasting or dropping an image INTO the contenteditable body inserts a visible
 * `<img src="blob:…" data-inline-cid="X">` at the caret; the bytes upload through
 * the composer's attachment path (marked as an inline part with a Content-ID),
 * and the send path later rewrites the image to `cid:<contentId>`.
 *
 * That `blob:` preview dies with the tab, so the draft stores the image without
 * a `src` (`serializeComposerBody`) and `fillSources()` puts one back after
 * every write of the body: this session's preview, else the URL of the row's
 * inline part (`sources`, #1285), which is what a reopened draft shows. An
 * image with neither has no src at all (a dead `blob:` from an older body
 * included) until its URL arrives.
 *
 * All of it belongs to one composition (`sources.scope`). The composer keys
 * the editor by it, so another composition always gets a fresh editor; should
 * the scope change under a mounted one anyway, the previews are dropped, and a
 * paste whose upload was still running is dropped too, as it is on unmount: it
 * is not inserted, and its part is taken off the draft it was attached to.
 *
 * Deleting the image from the body (select + Backspace) drops the pending inline
 * part: `reconcile()` diffs the tracked content-IDs against what's still in the
 * DOM and calls `onRemoveEmbeddedImage` for any that vanished.
 *
 * This DOM-heavy concern lives here (rather than inline in `PostboxBasicEditor.vue`)
 * so the editor component stays under the file-size ratchet and the caret
 * insertion / reconcile logic can be reasoned about in isolation.
 */
import { getCurrentScope, onScopeDispose, watch, type Ref } from 'vue';
import { fillInlineImageSources } from '~/utils/postboxInlineImageSrc';

export interface InlineImagesOptions {
	editorRef: Ref<HTMLElement | null>;
	/** True when pasting/dropping images should embed inline (off for signatures). */
	enabled: () => boolean;
	/** Upload an image → contentId + ephemeral preview URL to insert, or null on failure. */
	embedImage: () =>
		| ((file: File) => Promise<{ contentId: string; previewUrl: string } | null>)
		| undefined;
	/** Called with the contentId of an inline image removed from the body. */
	onRemoveEmbeddedImage: () => ((contentId: string) => void) | undefined;
	/** Re-emit + re-sync the draft after an insertion. */
	emitContent: () => void;
	/** Display URLs of the inline parts already on the draft row. */
	sources?: () => InlineImageSources | undefined;
}

/** The URLs of one composition's inline parts, by Content-ID; `scope` names the composition. */
export interface InlineImageSources {
	scope: string;
	urls: ReadonlyMap<string, string>;
}

export function usePostboxInlineImages(opts: InlineImagesOptions) {
	// Tracks which inline content-IDs currently live in the editor so a deletion
	// (the user selects the <img> and hits Backspace) can drop the pending part.
	const knownInlineCids = new Set<string>();
	// This session's preview URL per inserted image, for when the body is
	// written again (the stored form has no src) before the row's URL is known.
	const previews = new Map<string, string>();
	// The composition the previews belong to, and a counter that moves when it
	// changes or the editor goes away: a paste started before then is dropped.
	let scope: string | null = null;
	let generation = 0;
	if (getCurrentScope()) onScopeDispose(() => (generation += 1));

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
		previews.set(contentId, previewUrl);
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
		const mine = generation;
		for (const file of files) {
			const result = await embed(file);
			if (mine !== generation) {
				// Another composition (or none) since: not this body's image.
				if (result) opts.onRemoveEmbeddedImage()?.(result.contentId);
				continue;
			}
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
	 * Give every inline image in the body its src: the row part's URL once known
	 * (it outlives the tab), else this composition's own preview, else none.
	 */
	function fillSources() {
		const stored = opts.sources?.();
		const nextScope = stored?.scope ?? null;
		if (nextScope !== scope) {
			if (scope !== null) {
				previews.clear();
				generation += 1;
			}
			scope = nextScope;
		}
		const el = opts.editorRef.value;
		if (!el || !opts.enabled()) return;
		fillInlineImageSources(el, (cid) => stored?.urls.get(cid) ?? previews.get(cid));
	}
	watch(() => opts.sources?.(), fillSources, { immediate: true });

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

	return { handlePaste, handleDrop, reconcile, fillSources };
}
