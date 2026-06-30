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
	minimized: boolean;
}

const MAX_COMPOSERS = 3;

export function usePostboxComposerStack() {
	const state = useState<ComposerSpec[]>('postbox:composer-stack', () => []);

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
		state.value = state.value.filter((c) => c.id !== id);
	}

	function minimize(id: string) {
		state.value = state.value.map((c) => (c.id === id ? { ...c, minimized: true } : c));
	}

	function restore(id: string) {
		state.value = state.value.map((c) => (c.id === id ? { ...c, minimized: false } : c));
	}

	return { state, open, close, minimize, restore };
}
