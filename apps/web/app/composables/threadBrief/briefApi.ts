/**
 * The thread brief's Convex functions, in one place for the web: the brief
 * read and the viewer's writes (`mail/interpret/brief.ts`), the view
 * preference (`preferences.ts`) and the item reactions (`reactions.ts`).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ItemReaction } from '@owlat/shared/threadBrief';

export type MailThreadRefArg = { kind: 'mail'; id: Id<'mailThreads'> };
export type BriefLocale = 'en' | 'de';

/** The brief's functions (each named, so the entry ledger sees its caller). */
export const interpretApi = {
	brief: {
		get: api.mail.interpret.brief.get,
		markSeen: api.mail.interpret.brief.markSeen,
		setViewOverride: api.mail.interpret.brief.setViewOverride,
	},
	preferences: {
		getViewPreference: api.mail.interpret.preferences.getViewPreference,
		setThreadDefaultView: api.mail.interpret.preferences.setThreadDefaultView,
	},
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
