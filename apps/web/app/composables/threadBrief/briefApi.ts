/**
 * Shared types of the thread brief's web code, and the item reactions.
 *
 * The brief read, `markSeen`, the per-thread view and the default-view
 * preference are called as `api.mail.interpret.*` where they are used.
 *
 * TODO(thread brief merge): the item reactions (`mail/interpret/reactions.ts`)
 * come from the wiring lane. Until they are merged into this branch they go
 * through the runtime `api` proxy with the contract's argument types spelled
 * out here; once merged, replace the cast with `api.mail.interpret.reactions`.
 */
import { api } from '@owlat/api';
import type { FunctionReference } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';
import type { ItemReaction } from '@owlat/shared/threadBrief';

export type MailThreadRefArg = { kind: 'mail'; id: Id<'mailThreads'> };
export type BriefLocale = 'en' | 'de';

type Mutation<Args extends Record<string, unknown>> = FunctionReference<
	'mutation',
	'public',
	Args,
	unknown
>;

type ItemArgs = { itemId: Id<'threadItems'> };

interface ReactionsApi {
	markDone: Mutation<ItemArgs>;
	undo: Mutation<ItemArgs>;
	untrack: Mutation<ItemArgs>;
	notARequest: Mutation<ItemArgs>;
	remind: Mutation<ItemArgs & { remindAt: number }>;
	confirmProposal: Mutation<ItemArgs>;
	markReceived: Mutation<ItemArgs>;
}

/** The item reactions (the cast described above). */
export const interpretApi = {
	reactions: (api.mail.interpret as unknown as { reactions: ReactionsApi }).reactions,
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
