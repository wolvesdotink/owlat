/**
 * Personal-mail delivery pipeline — thread resolution.
 *
 * Decides which `mailThreads` row a delivered message joins, for every path
 * that goes through `insertDeliveredMessage` (hosted MX, external IMAP sync,
 * archive import, the brief email):
 *
 *   1. In-Reply-To / References → the thread of a message we already hold.
 *   2. Otherwise, the thread of a message that shares this one's conversation
 *      root (see {@link conversationRootId}), or whose root IS this message.
 *      That is what keeps a conversation together when its messages arrive out
 *      of order: a history import walks each folder newest-first, so a reply
 *      lands before the message it answers, and step 1 cannot see a parent it
 *      does not hold yet.
 *   3. Otherwise, ONLY for a message that looks like a reply (it carries
 *      threading headers, or its subject opens with a reply marker): the newest
 *      same-subject thread active within the window that shares an external
 *      correspondent with it.
 *   4. Anything else starts a new thread.
 *
 * Step 3 used to attach any message to the oldest same-subject thread seen in
 * the last 24h, whoever it was from or to. Two identical outreach mails to two
 * customers became one thread, their replies followed, and the Reply Queue and
 * draft-on-arrival then read one customer's mail as context for the other
 * (issue #817).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { normalizeEmail } from '@owlat/shared';
import { hasReplyPrefix } from '../../lib/emailAddress';
import { mailboxOwnAddresses } from '../identities';

/** How close to a thread's latest message a reply may land and still join it. */
const SUBJECT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many same-subject threads (newest first) the fallback inspects. Enough to
 * skip past a handful of recent same-subject conversations with other people;
 * the fallback is a last resort, so a bounded read beats completeness.
 */
const SUBJECT_CANDIDATE_LIMIT = 20;

/**
 * `addresses` minus the mailbox's own, as a set. Entries without an `@` are
 * dropped: `extractEmail` passes unparseable headers through as-is, and a
 * placeholder like `undisclosed-recipients:;` is nobody's correspondent.
 */
function externalOf(addresses: Iterable<string>, own: Set<string>): Set<string> {
	const external = new Set<string>();
	for (const address of addresses) {
		const normalized = normalizeEmail(address);
		if (normalized.includes('@') && !own.has(normalized)) external.add(normalized);
	}
	return external;
}

/**
 * The Message-ID a conversation started from, as far as this message can tell:
 * the first References entry (RFC 5322 §3.6.4 keeps the thread's first message
 * there even when a client trims the middle of the chain), else In-Reply-To for
 * clients that send no References, else the message's own id — it starts the
 * conversation. All ids are bare, without angle brackets.
 */
export function conversationRootId(
	messageId: string,
	inReplyTo: string | undefined,
	references: string[]
): string {
	return references[0] ?? inReplyTo ?? messageId;
}

/**
 * Resolve the thread a delivered message belongs to, or `null` when it starts a
 * new one. `parties` are the bare addresses on the message (from, to, cc);
 * `references` is In-Reply-To first, then the References chain. `messageId` is
 * the message's own bare Message-ID and `rootId` its {@link conversationRootId}.
 */
export async function resolveDeliveryThread(
	ctx: MutationCtx,
	params: {
		mailbox: Doc<'mailboxes'>;
		messageId: string;
		rootId: string;
		references: string[];
		subject: string;
		normalizedSubject: string;
		receivedAt: number;
		parties: string[];
	}
): Promise<Id<'mailThreads'> | null> {
	const { mailbox } = params;

	for (const candidate of params.references) {
		const referenced = await ctx.db
			.query('mailMessages')
			.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', candidate))
			.filter((q) => q.eq(q.field('mailboxId'), mailbox._id))
			.first();
		if (referenced) return referenced.threadId;
	}

	// Same conversation root, or this message is the root a held message points
	// at. The second key matters for a client that sends only In-Reply-To: its
	// reply's root is the parent's own id, not the parent's root.
	for (const root of new Set([params.rootId, params.messageId])) {
		const relative = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_thread_root', (q) =>
				q.eq('mailboxId', mailbox._id).eq('threadRootId', root)
			)
			.first();
		if (relative) return relative.threadId;
	}

	// A message with no threading headers and no reply marker is a new
	// conversation by definition, however common its subject is.
	const looksLikeReply = params.references.length > 0 || hasReplyPrefix(params.subject);
	if (!looksLikeReply || !params.normalizedSubject) return null;

	const own = await mailboxOwnAddresses(ctx, mailbox);
	const correspondents = externalOf(params.parties, own);
	if (correspondents.size === 0) return null;

	const candidates = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_and_subject', (q) =>
			q.eq('mailboxId', mailbox._id).eq('normalizedSubject', params.normalizedSubject)
		)
		.order('desc')
		.take(SUBJECT_CANDIDATE_LIMIT);

	let best: Doc<'mailThreads'> | null = null;
	for (const thread of candidates) {
		if (Math.abs(params.receivedAt - thread.lastMessageAt) > SUBJECT_WINDOW_MS) continue;
		const shared = [...externalOf(thread.participants, own)].some((p) => correspondents.has(p));
		if (!shared) continue;
		if (!best || thread.lastMessageAt > best.lastMessageAt) best = thread;
	}
	return best?._id ?? null;
}
