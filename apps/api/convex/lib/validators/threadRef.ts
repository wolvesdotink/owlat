/**
 * The typed thread reference shared by the thread brief tables (SPEC §1).
 *
 * `{ kind: 'mail', id }` names a Postbox `mailThreads` row (personal or shared
 * mailbox), `{ kind: 'team', id }` an agent Team Inbox `conversationThreads`
 * row. Neither thread store is migrated.
 *
 * A table cannot index into a union, so every table stores the reference as
 * {@link threadRefFields}: the `threadKind` discriminator plus exactly one of
 * `mailThreadId` / `conversationThreadId`, the polymorphic-FK pattern of
 * CONVENTIONS.md. Write it with {@link threadRefToFields} and read it back
 * with {@link threadRefFromFields}, so the xor invariant holds by construction.
 *
 * Authorization is the source thread's: mailbox access for `mail`, team inbox
 * membership for `team`.
 */

import { v, type Infer } from 'convex/values';
import { THREAD_REF_KINDS } from '@owlat/shared/threadBrief';
import type { Id } from '../../_generated/dataModel';
import { literalUnion } from '../literalUnion';

export const threadRefKindValidator = literalUnion(THREAD_REF_KINDS);

export const mailThreadRefValidator = v.object({
	kind: v.literal('mail'),
	id: v.id('mailThreads'),
});

export const teamThreadRefValidator = v.object({
	kind: v.literal('team'),
	id: v.id('conversationThreads'),
});

/** Function argument / return shape of a thread reference. */
export const threadRefValidator = v.union(mailThreadRefValidator, teamThreadRefValidator);

export type ThreadRef = Infer<typeof threadRefValidator>;
export type MailThreadRef = Infer<typeof mailThreadRefValidator>;
export type TeamThreadRef = Infer<typeof teamThreadRefValidator>;

/** The indexed columns every thread brief table spreads into its row. */
export const threadRefFields = {
	threadKind: threadRefKindValidator,
	// Set when threadKind === 'mail'.
	mailThreadId: v.optional(v.id('mailThreads')),
	// Set when threadKind === 'team'.
	conversationThreadId: v.optional(v.id('conversationThreads')),
};

export type ThreadRefColumns =
	| { threadKind: 'mail'; mailThreadId: Id<'mailThreads'>; conversationThreadId?: undefined }
	| {
			threadKind: 'team';
			conversationThreadId: Id<'conversationThreads'>;
			mailThreadId?: undefined;
	  };

/** Split a reference into the indexed columns. */
export function threadRefToFields(ref: ThreadRef): ThreadRefColumns {
	return ref.kind === 'mail'
		? { threadKind: 'mail', mailThreadId: ref.id }
		: { threadKind: 'team', conversationThreadId: ref.id };
}

/**
 * Rebuild the reference from a stored row. Throws on a row that breaks the xor
 * invariant (wrong or missing id for its kind): that row was not written
 * through {@link threadRefToFields}.
 */
export function threadRefFromFields(row: {
	threadKind: ThreadRef['kind'];
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
}): ThreadRef {
	if (row.threadKind === 'mail' && row.mailThreadId && !row.conversationThreadId) {
		return { kind: 'mail', id: row.mailThreadId };
	}
	if (row.threadKind === 'team' && row.conversationThreadId && !row.mailThreadId) {
		return { kind: 'team', id: row.conversationThreadId };
	}
	throw new Error(`threadRef columns do not match threadKind '${row.threadKind}'`);
}

/** A stable string for maps, dedup keys and idempotency keys: `mail:<id>` / `team:<id>`. */
export function threadRefKey(ref: ThreadRef): string {
	return `${ref.kind}:${ref.id}`;
}

/** Whether two references name the same thread. */
export function isSameThreadRef(a: ThreadRef, b: ThreadRef): boolean {
	return a.kind === b.kind && a.id === b.id;
}

/** Whether a stored row belongs to the given thread (for "validated against the same thread"). */
export function rowMatchesThreadRef(
	row: {
		threadKind: ThreadRef['kind'];
		mailThreadId?: Id<'mailThreads'>;
		conversationThreadId?: Id<'conversationThreads'>;
	},
	ref: ThreadRef
): boolean {
	return ref.kind === 'mail'
		? row.threadKind === 'mail' && row.mailThreadId === ref.id
		: row.threadKind === 'team' && row.conversationThreadId === ref.id;
}
