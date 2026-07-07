/**
 * Manages up to 3 simultaneous popup composers (Gmail-style).
 *
 * Each entry holds a one-time seed for usePostboxCompose.
 */

import type { Id } from '@owlat/api/dataModel';

export interface ComposerSpec {
	id: string;
	mailboxId: Id<'mailboxes'>;
	draftId?: Id<'mailDrafts'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	prefillTo?: string[];
	prefillCc?: string[];
	prefillBcc?: string[];
	prefillSubject?: string;
	prefillBodyHtml?: string;
	/** Clone this message's attachments onto the new draft (Forward). */
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
	/** Attach a transient generated file (key into usePostboxPendingAttachments). */
	attachPendingKey?: string;
	/**
	 * On a plain Reply, the recipients a Reply-All would additionally include
	 * (raw address strings). Drives the dismissible "Also include …" gap hint
	 * under the To field. Empty/undefined on Reply-All, forwards, and new mail.
	 */
	replyAllRecipients?: string[];
	minimized: boolean;
}

export type InlineComposeKind = 'reply' | 'replyAll' | 'forward';

/**
 * Seed for the reader's inline reply box (PostboxInlineReply) — the same
 * one-time compose seed as a popup, minus the stack bookkeeping. `key` changes
 * whenever the seed changes so the inline composer remounts and re-seeds.
 */
export interface InlineComposeSpec extends Omit<ComposerSpec, 'id' | 'minimized'> {
	key: string;
	kind: InlineComposeKind;
}

/**
 * Live field values handed up when an inline composer is promoted to a popup.
 * The popup reopens the SAME draft (autosave was flushed first), and the live
 * values seed it so nothing typed in the last debounce window flashes stale.
 */
export interface ComposerPromotePayload {
	draftId: Id<'mailDrafts'> | null;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
}

const MAX_COMPOSERS = 3;

export function usePostboxComposerStack() {
	const state = useState<ComposerSpec[]>('postbox:composer-stack', () => []);
	// Id of the composer currently promoted to the centered focus surface, or
	// null when every composer is in its normal popup/dock frame. Only one
	// composer can hold focus at a time.
	const focusedId = useState<string | null>('postbox:composer-focused', () => null);

	// The composer a "focus compose" chord acts on: the newest still-open
	// (non-minimized) composer, or null when none is expanded.
	const activeComposerId = computed<string | null>(() => {
		for (let i = state.value.length - 1; i >= 0; i--) {
			const c = state.value[i]!;
			if (!c.minimized) return c.id;
		}
		return null;
	});

	function open(spec: Omit<ComposerSpec, 'id' | 'minimized'>): string {
		if (state.value.length >= MAX_COMPOSERS) {
			// Replace the oldest minimized composer to make room
			const oldestMinimized = state.value.findIndex((c) => c.minimized);
			if (oldestMinimized >= 0) {
				state.value.splice(oldestMinimized, 1);
			} else {
				return state.value[state.value.length - 1]!.id;
			}
		}
		const id = `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
		state.value = [...state.value, { id, minimized: false, ...spec }];
		return id;
	}

	function close(id: string) {
		if (focusedId.value === id) focusedId.value = null;
		state.value = state.value.filter((c) => c.id !== id);
	}

	function minimize(id: string) {
		// Minimizing docks the composer, so it can no longer hold the focus surface.
		if (focusedId.value === id) focusedId.value = null;
		state.value = state.value.map((c) => (c.id === id ? { ...c, minimized: true } : c));
	}

	function restore(id: string) {
		state.value = state.value.map((c) => (c.id === id ? { ...c, minimized: false } : c));
	}

	/**
	 * Bring a docked composer back to a floating popup: un-minimize it AND move
	 * it to the end of the stack so it counts as one of the newest (and so wins a
	 * popup slot back from an overflow it had been pushed into). Used by the dock
	 * chip restore.
	 */
	function bringToFront(id: string) {
		const spec = state.value.find((c) => c.id === id);
		if (!spec) return;
		state.value = [...state.value.filter((c) => c.id !== id), { ...spec, minimized: false }];
	}

	/** Promote a composer to the centered distraction-free surface. */
	function focus(id: string) {
		const spec = state.value.find((c) => c.id === id);
		if (!spec || spec.minimized) return;
		focusedId.value = id;
	}

	/** Demote the focused composer back to its popup frame. */
	function unfocus() {
		focusedId.value = null;
	}

	/**
	 * Toggle the focus surface for the active composer (the Cmd-Shift-F chord).
	 * Focusing an already-focused composer demotes it; otherwise the newest open
	 * composer is promoted. No-op when nothing is open.
	 */
	function toggleFocusActive() {
		const id = activeComposerId.value;
		if (!id) return;
		if (focusedId.value === id) unfocus();
		else focus(id);
	}

	return {
		state,
		focusedId,
		activeComposerId,
		open,
		close,
		minimize,
		restore,
		bringToFront,
		focus,
		unfocus,
		toggleFocusActive,
	};
}
