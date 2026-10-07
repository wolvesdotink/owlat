/**
 * The thread brief's Convex functions, in one place for the web.
 *
 * TODO(thread brief merge): the interpret lane (`mail/interpret/brief.ts`,
 * `preferences.ts`) and the wiring lane (`reactions.ts`) land these in the
 * generated api. Until they are merged into this branch the references go
 * through the runtime `api` proxy with the contract's argument and return
 * types spelled out here; once merged, replace each cast with the direct
 * `api.mail.interpret.*` reference so typecheck checks the names and shapes.
 */
import { api } from '@owlat/api';
import type { FunctionReference } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';
import type { ItemReaction, ThreadView } from '@owlat/shared/threadBrief';
import type { ThreadBriefView } from '../../../../api/convex/mail/interpret/briefShape';

export type MailThreadRefArg = { kind: 'mail'; id: Id<'mailThreads'> };
export type BriefLocale = 'en' | 'de';

type Query<Args extends Record<string, unknown>, Ret> = FunctionReference<
	'query',
	'public',
	Args,
	Ret
>;
type Mutation<Args extends Record<string, unknown>> = FunctionReference<
	'mutation',
	'public',
	Args,
	unknown
>;

type ItemArgs = { itemId: Id<'threadItems'> };

interface InterpretApi {
	brief: {
		get: Query<{ threadRef: MailThreadRefArg; locale: BriefLocale }, ThreadBriefView | null>;
		markSeen: Mutation<{ threadRef: MailThreadRefArg; interpretationRevision: number }>;
		setViewOverride: Mutation<{ threadRef: MailThreadRefArg; view: ThreadView }>;
	};
	preferences: {
		getViewPreference: Query<Record<string, never>, { threadDefaultView: ThreadView }>;
		setThreadDefaultView: Mutation<{ view: ThreadView }>;
	};
	reactions: {
		markDone: Mutation<ItemArgs>;
		undo: Mutation<ItemArgs>;
		untrack: Mutation<ItemArgs>;
		notARequest: Mutation<ItemArgs>;
		remind: Mutation<ItemArgs & { remindAt: number }>;
		confirmProposal: Mutation<ItemArgs>;
		markReceived: Mutation<ItemArgs>;
	};
}

/** The brief's functions (see the TODO above). */
export const interpretApi = (api.mail as unknown as { interpret: InterpretApi }).interpret;

/** The reactions that change the item itself (the rest open Answer mode). */
export type MutatingReaction = Extract<
	ItemReaction,
	'markDone' | 'markPaid' | 'markReceived' | 'untrack' | 'notARequest' | 'remind'
>;

/** The brief's locale: German for any `de*` UI locale, English otherwise. */
export function briefLocale(locale: string): BriefLocale {
	return locale.toLowerCase().startsWith('de') ? 'de' : 'en';
}
