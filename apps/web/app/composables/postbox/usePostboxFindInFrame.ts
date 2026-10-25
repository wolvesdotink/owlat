/**
 * Find in conversation inside one message body's iframe: the marks, the
 * scroll to the active match, and the find shortcut pressed while the frame
 * has the keyboard.
 *
 * The frame is same-origin and script-free (see PostboxMessageBody), so its
 * document is ours to read and mark, and nothing inside it runs. Marks are
 * re-applied whenever the frame loads a new document (a new render, images
 * shown, the quote shown for a match, the dark/light toggle) and removed when
 * the card has nothing to mark; only find's own marks are touched, so a cited
 * quote's mark stays.
 *
 * Key presses inside the frame never reach the app's dispatcher: events do
 * not cross a document. A press the shortcut registry resolves to find is
 * re-dispatched on the frame element, where it bubbles to the dispatcher like
 * any other press, and the original is cancelled only when the reader took
 * it, so the browser's own find stays where no reader answers.
 */
import { onBeforeUnmount, watch, type Ref } from 'vue';
import { prefersReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import { activeShortcutScopes, resolveActiveChord } from '~/utils/shortcutScope';
import { clearPostboxFindMarks, markPostboxFindMatches } from '~/utils/postboxFindHighlights';
import type { PostboxMessageFind } from './usePostboxThreadFind';

const FIND_SHORTCUT_ID = 'global.findInConversation';

export function usePostboxFindInFrame(opts: {
	frame: Ref<HTMLIFrameElement | null>;
	find: () => PostboxMessageFind | null | undefined;
}) {
	// Whether this frame's document may hold marks: a body find never touched
	// is never walked.
	let marked = false;
	// The reveal already scrolled to, so a reload (images shown) does not pull
	// the reader back to a match it has since scrolled away from.
	let scrolledFor = 0;
	let keyDoc: Document | null = null;
	let keyView: Window | null = null;

	function forwardFindKey(event: KeyboardEvent) {
		if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented) return;
		const id = resolveActiveChord(chordFromEvent(event), activeShortcutScopes());
		if (id !== FIND_SHORTCUT_ID) return;
		const frame = opts.frame.value;
		if (!frame) return;
		const forwarded = new KeyboardEvent('keydown', {
			key: event.key,
			code: event.code,
			metaKey: event.metaKey,
			ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			repeat: event.repeat,
			bubbles: true,
			cancelable: true,
		});
		frame.dispatchEvent(forwarded);
		if (forwarded.defaultPrevented) event.preventDefault();
	}

	function listenForKeys(doc: Document | null) {
		if (doc === keyDoc) return;
		keyView?.removeEventListener('keydown', forwardFindKey);
		keyDoc = doc;
		// Each document the frame loads has a window of its own; the press
		// bubbles to it from wherever in the body it was aimed.
		keyView = doc?.defaultView ?? null;
		// oxlint-disable-next-line owlat/no-raw-keydown-listener -- the body frame's own window: presses there never reach the app dispatcher, so the find chord is resolved through the registry and handed to it
		keyView?.addEventListener('keydown', forwardFindKey);
	}

	function apply() {
		const doc = opts.frame.value?.contentDocument ?? null;
		if (!doc?.body) return;
		listenForKeys(doc);
		const find = opts.find();
		if (!find) {
			if (marked) clearPostboxFindMarks(doc);
			marked = false;
			return;
		}
		marked = true;
		const result = markPostboxFindMatches(doc, find.needle, find.active);
		if (result.active && find.reveal !== scrolledFor) {
			scrolledFor = find.reveal;
			result.active.scrollIntoView({
				block: 'center',
				behavior: prefersReducedMotion() ? 'auto' : 'smooth',
			});
		}
	}

	watch(
		opts.frame,
		(frame, previous) => {
			previous?.removeEventListener('load', apply);
			frame?.addEventListener('load', apply);
			// A frame that already holds its document (a re-bound ref).
			if (frame?.contentDocument?.readyState === 'complete') apply();
		},
		{ immediate: true, flush: 'post' }
	);
	// Keyed on what the marks depend on, so an unrelated re-render of the
	// reader never re-walks the document.
	watch(
		() => {
			const find = opts.find();
			return find ? `${find.needle}\u0000${find.active}\u0000${find.reveal}` : '';
		},
		() => apply(),
		{ flush: 'post' }
	);
	onBeforeUnmount(() => {
		opts.frame.value?.removeEventListener('load', apply);
		listenForKeys(null);
	});
}
