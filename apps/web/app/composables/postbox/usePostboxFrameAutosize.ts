import { onScopeDispose, watch, type Ref, type WatchSource } from 'vue';
import { createRafThrottle } from './usePostboxVirtualList';

/**
 * Keep a same-origin email iframe as tall as its document.
 *
 * Measuring only on the frame's `load` event left every newsletter in the
 * min-height box, with an inner scrollbar, until its last remote image had
 * arrived, and a pane resize that reflowed the text never re-measured at all.
 * This sizes the frame as soon as its document is parsed (readyState
 * `interactive`, the DOMContentLoaded point) and then follows it with a
 * ResizeObserver on the document element, so late images, web fonts and
 * width changes all re-fit it.
 *
 * The frame is sandboxed without `allow-scripts`, so nothing can run inside it
 * to announce DOMContentLoaded; the host polls the frame once per animation
 * frame after each `srcdoc` change until the NEW document is parsed. `load`
 * stays wired as the fallback.
 *
 * Observer callbacks are coalesced to one measurement per animation frame, and
 * a change under 1px is ignored, so sub-pixel layout jitter never re-lays out
 * the reader.
 */

/** Frames to poll for the parsed document before leaving it to `load`. */
const DOCUMENT_POLL_FRAMES = 120;

interface PostboxFrameAutosizeOptions {
	iframeRef: Ref<HTMLIFrameElement | null>;
	/** The document the frame renders: a change means a new frame document. */
	srcdoc: WatchSource<string>;
	/** Floor for the fitted height, in CSS pixels. */
	minHeight: () => number;
	/** Called with every applied height (for the pre-size cache). */
	onHeight: (height: number) => void;
}

export function usePostboxFrameAutosize(options: PostboxFrameAutosizeOptions): {
	/** Measure now (tests and explicit re-fits). */
	measure: () => void;
} {
	let frame: HTMLIFrameElement | null = null;
	let boundDoc: Document | null = null;
	/** The document that was showing when `srcdoc` last changed: never bind it. */
	let staleDoc: Document | null = null;
	let observer: ResizeObserver | null = null;
	let lastHeight: number | null = null;
	let pollHandle: number | null = null;
	let pollFramesLeft = 0;

	function measure() {
		const doc = frame?.contentDocument;
		if (!frame || !doc?.documentElement) return;
		const height = Math.max(options.minHeight(), doc.documentElement.scrollHeight);
		if (lastHeight !== null && Math.abs(height - lastHeight) < 1) return;
		lastHeight = height;
		frame.style.height = `${height}px`;
		options.onHeight(height);
	}

	const scheduled = createRafThrottle(measure);

	function unbind() {
		observer?.disconnect();
		observer = null;
		boundDoc = null;
		scheduled.cancel();
	}

	function bind(doc: Document) {
		if (doc === boundDoc) return;
		unbind();
		boundDoc = doc;
		lastHeight = null;
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		observer = new ResizeObserver(() => scheduled.schedule());
		observer.observe(doc.documentElement);
		if (doc.body) observer.observe(doc.body);
	}

	/** The frame's document, once it is the new one and has been parsed. */
	function parsedDocument(): Document | null {
		const doc = frame?.contentDocument;
		if (!doc || doc === staleDoc || doc.readyState === 'loading') return null;
		// The initial about:blank a fresh frame holds before its srcdoc commits.
		if (doc.URL === 'about:blank') return null;
		return doc;
	}

	function stopPolling() {
		if (pollHandle !== null && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(pollHandle);
		}
		pollHandle = null;
	}

	function poll() {
		pollHandle = null;
		const doc = parsedDocument();
		if (doc) {
			bind(doc);
			return;
		}
		if (--pollFramesLeft <= 0) return;
		pollHandle = requestAnimationFrame(poll);
	}

	function awaitDocument() {
		stopPolling();
		const doc = parsedDocument();
		if (doc) {
			bind(doc);
			return;
		}
		if (typeof requestAnimationFrame !== 'function') return;
		pollFramesLeft = DOCUMENT_POLL_FRAMES;
		pollHandle = requestAnimationFrame(poll);
	}

	function onLoad() {
		stopPolling();
		const doc = frame?.contentDocument;
		if (!doc) return;
		staleDoc = null;
		if (doc === boundDoc) measure();
		else bind(doc);
	}

	function detach() {
		stopPolling();
		unbind();
		frame?.removeEventListener('load', onLoad);
		frame = null;
		staleDoc = null;
	}

	// The frame mounts late when a loading skeleton renders first, and the
	// reader can swap it out, so follow the template ref rather than onMounted.
	watch(
		options.iframeRef,
		(next) => {
			if (next === frame) return;
			detach();
			if (!next) return;
			frame = next;
			frame.addEventListener('load', onLoad);
			awaitDocument();
		},
		{ immediate: true, flush: 'post' }
	);

	// A new srcdoc (another message, show images, show quoted text) navigates
	// the frame to a new document. Stop observing the outgoing one right away so
	// its height is never recorded against the new render.
	watch(
		options.srcdoc,
		() => {
			if (!frame) return;
			staleDoc = boundDoc ?? frame.contentDocument;
			unbind();
			awaitDocument();
		},
		{ flush: 'post' }
	);

	onScopeDispose(detach);

	return { measure };
}
