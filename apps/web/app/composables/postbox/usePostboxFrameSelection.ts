/**
 * The passage selected inside one message body's iframe, for "Quote in reply".
 *
 * The frame is same-origin but runs no script (see PostboxMessageBody), so
 * the host listens on the frame's own document: its `selectionchange`, and
 * its keys, because a key pressed in the frame never reaches the reader's
 * window listener. Inside the frame, over a selection, the reply shortcut (as
 * the registry resolves it, remaps included) quotes it, Escape lets it go and
 * Tab moves to the action; every other key is left alone.
 *
 * A selection belongs to the one document it was made in: a new `srcdoc`
 * (another message, images shown, the theme), a replaced frame or the end of
 * the component drops it and unbinds. A click on the page outside the action
 * drops it too, and so does focus moving anywhere but the frame and its action
 * (another message's frame, which the host page never sees a click in, or a
 * control reached by keyboard), so the action never lingers over a selection
 * the browser shows as inactive. Leaving the app keeps it: the frame or the
 * action still holds the page's focus when the window comes back.
 */
import { onScopeDispose, shallowRef, watch, type Ref, type WatchSource } from 'vue';
import { normalizeQuotedPassage } from '~/utils/postboxSelectedQuote';
import { resolvePostboxShortcut } from '~/utils/postboxShortcuts';

/** The selection's last line box, in the frame element's coordinates. */
export interface FrameSelectionAnchor {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export interface FrameSelection {
	/** The passage as it would be quoted (`normalizeQuotedPassage`). */
	text: string;
	anchor: FrameSelectionAnchor;
}

export function usePostboxFrameSelection(opts: {
	iframeRef: Ref<HTMLIFrameElement | null>;
	/** The document the frame renders: a change means a new frame document. */
	srcdoc: WatchSource<string>;
	/** Whether a passage may be quoted from this body at all. */
	enabled: () => boolean;
	/** The reply shortcut, pressed in the frame over a selection. */
	onQuote: (text: string) => void;
	/** The action's element: a press on it keeps the selection. */
	actionEl: () => HTMLElement | null;
	/** Tab in the frame over a selection: focus the action. */
	focusAction: () => void;
}) {
	const selection = shallowRef<FrameSelection | null>(null);
	let frame: HTMLIFrameElement | null = null;
	let boundDoc: Document | null = null;

	function read(): FrameSelection | null {
		const doc = boundDoc;
		if (!doc?.body || !frame || !opts.enabled()) return null;
		const sel = doc.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		if (!doc.body.contains(range.commonAncestorContainer)) return null;
		const text = normalizeQuotedPassage(sel.toString());
		if (!text) return null;
		const lines = range.getClientRects();
		const last = lines.length > 0 ? lines[lines.length - 1] : range.getBoundingClientRect();
		if (!last) return null;
		// The frame's viewport starts inside its border.
		const dx = frame.clientLeft;
		const dy = frame.clientTop;
		return {
			text,
			anchor: {
				top: last.top + dy,
				bottom: last.bottom + dy,
				left: last.left + dx,
				right: last.right + dx,
			},
		};
	}

	function update() {
		selection.value = read();
	}

	/** Drop the selection (and the browser's highlight of it). */
	function clear() {
		boundDoc?.getSelection()?.removeAllRanges();
		selection.value = null;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.isComposing || event.defaultPrevented) return;
		const current = read();
		if (!current) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			clear();
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === 'Tab') {
			if (event.shiftKey) return;
			event.preventDefault();
			selection.value = current;
			opts.focusAction();
			return;
		}
		if (resolvePostboxShortcut(event.key) !== 'reply') return;
		event.preventDefault();
		opts.onQuote(current.text);
	}

	function onHostPointerDown(event: Event) {
		const action = opts.actionEl();
		if (action && event.target instanceof Node && action.contains(event.target)) return;
		clear();
	}

	/**
	 * Focus moved to `next` (the host page's active element). The page's body
	 * is the in-between state while focus crosses into a host element, whose
	 * own `focusin` follows; the frame itself means focus stayed (or the app
	 * lost focus as a whole).
	 */
	function onFocusMoved(next: EventTarget | null) {
		if (!selection.value || !(next instanceof Element) || next === document.body) return;
		if (next === frame || opts.actionEl()?.contains(next)) return;
		clear();
	}
	const onFocusLeft = () => onFocusMoved(document.activeElement);
	const onHostFocusIn = (event: FocusEvent) => onFocusMoved(event.target);

	/** Listening on the host page, only while a selection shows. */
	function listenOnHost() {
		document.addEventListener('pointerdown', onHostPointerDown, true);
		document.addEventListener('focusin', onHostFocusIn, true);
		// Focus leaving the host document (the action) for another frame.
		window.addEventListener('blur', onFocusLeft);
	}
	function stopListeningOnHost() {
		document.removeEventListener('pointerdown', onHostPointerDown, true);
		document.removeEventListener('focusin', onHostFocusIn, true);
		window.removeEventListener('blur', onFocusLeft);
	}

	function unbind() {
		if (boundDoc) {
			boundDoc.removeEventListener('selectionchange', update);
			boundDoc.removeEventListener('keydown', onKeydown);
			boundDoc.defaultView?.removeEventListener('resize', update);
			boundDoc.defaultView?.removeEventListener('blur', onFocusLeft);
		}
		boundDoc = null;
		selection.value = null;
	}

	function bind() {
		// A body that offers no quoting never touches its frame's document.
		if (!opts.enabled()) return;
		const doc = frame?.contentDocument;
		if (!doc || doc === boundDoc) return;
		// The initial about:blank a fresh frame holds before its srcdoc commits.
		if (doc.URL === 'about:blank' || doc.readyState === 'loading') return;
		unbind();
		boundDoc = doc;
		doc.addEventListener('selectionchange', update);
		// oxlint-disable-next-line owlat/no-raw-keydown-listener -- resolves its keys through the registry (resolvePostboxShortcut)
		doc.addEventListener('keydown', onKeydown);
		doc.defaultView?.addEventListener('resize', update);
		// Focus leaving the frame: the host page's active element is already
		// where it went when that is another frame.
		doc.defaultView?.addEventListener('blur', onFocusLeft);
		update();
	}

	function detach() {
		unbind();
		frame?.removeEventListener('load', bind);
		frame = null;
	}

	// The frame mounts late (after the loading skeleton) and can be swapped.
	watch(
		opts.iframeRef,
		(next) => {
			if (next === frame) return;
			detach();
			if (!next) return;
			frame = next;
			frame.addEventListener('load', bind);
			bind();
		},
		{ immediate: true, flush: 'post' }
	);

	// A new srcdoc navigates the frame: the old document's selection is gone,
	// and its `load` binds the new one.
	watch(opts.srcdoc, () => unbind(), { flush: 'post' });

	// Quoting switched off (the host lost the message, say): no action shows,
	// and nothing listens to the frame until it is switched back on.
	watch(opts.enabled, (enabled) => {
		if (!enabled) {
			unbind();
			return;
		}
		bind();
		update();
	});

	// Only while a selection shows: a press or focus anywhere else on the page drops it.
	watch(selection, (current, previous) => {
		if (current && !previous) listenOnHost();
		if (!current && previous) stopListeningOnHost();
	});

	onScopeDispose(() => {
		detach();
		stopListeningOnHost();
	});

	return { selection, clear };
}
