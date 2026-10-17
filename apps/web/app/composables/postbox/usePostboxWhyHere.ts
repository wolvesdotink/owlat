/**
 * The "Why here?" seam (SPEC §3, §4.1). The calm reader renders the link in
 * the strip's meta row (or the slim "Why here? · Details" line) and in the
 * header ⋯ menu; what it opens belongs to lane `learn` (the popover that
 * answers from the arrival record, with "That's wrong", "Always here" and the
 * Senders page).
 *
 * Learn hooks in by providing a handler from any ancestor of the reader and
 * the Priority view (PostboxLayout covers both, as does an app-level plugin):
 *
 *   provide(POSTBOX_WHY_HERE_KEY, { open: (target) => … });
 *
 * Without a provider the link renders and opens nothing.
 */
import { inject, type InjectionKey } from 'vue';
import type { Placement } from '@owlat/shared/arrival';

/** What a "Why here?" click is about. */
export interface PostboxWhyHereTarget {
	mailboxId: string;
	threadId: string;
	/** The thread's effective placement, when it has an arrival projection. */
	placement?: Placement;
	/** The element the click came from, to anchor a popover on. */
	anchor: HTMLElement | null;
}

export interface PostboxWhyHereHandler {
	open: (target: PostboxWhyHereTarget) => void;
}

export const POSTBOX_WHY_HERE_KEY: InjectionKey<PostboxWhyHereHandler> = Symbol('postboxWhyHere');

export function usePostboxWhyHere() {
	const handler = inject(POSTBOX_WHY_HERE_KEY, null);
	return {
		open(target: PostboxWhyHereTarget) {
			handler?.open(target);
		},
	};
}
