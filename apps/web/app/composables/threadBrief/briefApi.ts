/**
 * Shared types of the thread brief's web code, and the item reactions.
 *
 * The brief read, `markSeen`, the per-thread view and the default-view
 * preference are called as `api.mail.interpret.*` where they are used; the
 * item reactions (`mail/interpret/reactions.ts`) are named here, each one,
 * so the entry ledger sees its caller.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ItemReaction } from '@owlat/shared/threadBrief';

export type MailThreadRefArg = { kind: 'mail'; id: Id<'mailThreads'> };
export type BriefLocale = 'en' | 'de';

/** The item reactions. */
export const interpretApi = {
	reactions: {
		markDone: api.mail.interpret.reactions.markDone,
		undo: api.mail.interpret.reactions.undo,
		untrack: api.mail.interpret.reactions.untrack,
		notARequest: api.mail.interpret.reactions.notARequest,
		remind: api.mail.interpret.reactions.remind,
		confirmProposal: api.mail.interpret.reactions.confirmProposal,
		markReceived: api.mail.interpret.reactions.markReceived,
	},
};

/** The reactions that change the item itself (the rest open Answer mode). */
export type MutatingReaction = Extract<
	ItemReaction,
	'markDone' | 'markPaid' | 'markReceived' | 'untrack' | 'notARequest' | 'remind'
>;

/** The brief's locale: German for any `de*` UI locale, English otherwise. */
export function briefLocale(locale: string): BriefLocale {
	return locale.toLowerCase().startsWith('de') ? 'de' : 'en';
}
