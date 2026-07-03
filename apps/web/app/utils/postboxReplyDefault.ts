/**
 * Default reply behavior for the Postbox reader: whether the primary reply
 * affordance (the Reply button and the `r` shortcut) opens a plain Reply or a
 * Reply-all. The explicit Reply-all affordance (`a` / the Reply-all button)
 * always opens a reply-all regardless of this preference.
 *
 * Pure derivation + in-place conversion so both are unit-testable without
 * mounting the Convex-backed reader. Recipient math is delegated to the shared,
 * better-tested helpers in `./recipientHints` — this module only decides which
 * mode the primary affordance uses and folds a plain reply into a reply-all.
 */

import { mergeRecipients } from '~/utils/recipientHints';

export type PostboxReplyDefaultMode = 'reply' | 'reply-all';

export const POSTBOX_REPLY_DEFAULT: PostboxReplyDefaultMode = 'reply';

export const POSTBOX_REPLY_DEFAULT_OPTIONS: Array<{
	value: PostboxReplyDefaultMode;
	label: string;
}> = [
	{ value: 'reply', label: 'Reply to the sender only' },
	{ value: 'reply-all', label: 'Reply to everyone (reply all)' },
];

/**
 * The reply kind the primary affordance (Reply button / `r`) should open for a
 * given default preference.
 *
 * Reply-all collapses to a plain reply when reply-all would add no one (a 1:1
 * message: `replyAllAddsRecipients` false) so the primary affordance never
 * opens a pointless reply-all with an empty Cc.
 */
export function resolvePrimaryReplyKind(
	mode: PostboxReplyDefaultMode,
	replyAllAddsRecipients: boolean
): 'reply' | 'replyAll' {
	return mode === 'reply-all' && replyAllAddsRecipients ? 'replyAll' : 'reply';
}

/** The envelope fields a reply draft carries through an in-place conversion. */
export interface ReplyDraftEnvelope {
	to: string[];
	cc: string[];
	subject: string;
	bodyHtml: string;
}

/**
 * Convert a plain-reply draft into a reply-all IN PLACE.
 *
 * `To` (the sender) is preserved; the reply-all extras — the other
 * participants a Reply-all would add, already deduped against the sender and
 * the user's own identities by `deriveReplyAllExtras` — are folded into `Cc`,
 * deduped once more against the existing Cc and the To field so nothing
 * doubles. Subject and body are returned untouched. This is the exact same
 * recipient math as opening a fresh reply-all, so the two paths cannot drift.
 */
export function convertReplyToReplyAll(
	draft: ReplyDraftEnvelope,
	replyAllExtras: readonly string[]
): ReplyDraftEnvelope {
	return {
		to: [...draft.to],
		cc: mergeRecipients(draft.cc, replyAllExtras, draft.to),
		subject: draft.subject,
		bodyHtml: draft.bodyHtml,
	};
}
