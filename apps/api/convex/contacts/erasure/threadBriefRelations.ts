/**
 * Contact erasure policy for the thread brief tables (schema/threadBrief.ts),
 * spread into `DESCENDANT_RELATIONS` (relations.ts). The phases are in
 * `threadBriefPhases.ts`:
 *
 *  - a Team Inbox thread of the contact takes every thread brief row with it
 *    (`eraseConversationThreads` → `drainThreadBrief`);
 *  - a received message of the contact in someone else's thread takes what
 *    the brief derived from it: its extractions, its evidence on the thread's
 *    items (an item left without evidence is deleted), the activity naming
 *    it, and the plans of the draft it carried (`eraseInboundMessages` →
 *    `eraseInboundMessageBrief`);
 *  - a deleted item's links are cleared from the rows outside the brief
 *    (`mail/interpret/purgeLinks.ts drainItemLinks`).
 *
 * Order matters to the coverage test, which seeds the relations in this
 * order: the thread brief tables first, then what points at their rows.
 */

import type { TableNames } from '../../_generated/dataModel';
import { THREAD_BRIEF_TABLES } from '../../schema/threadBrief';
import type { DescendantRelation, ErasureAction } from './relations';

const WITH_THREAD =
	'Derived from the thread’s mail (items, facts, activity, plans, viewer state); deleted with the thread.';
const IN_THREAD =
	'Points within one thread, whose thread brief rows are all deleted by their conversationThreadId.';
const MAIL_ONLY =
	'Postbox only: a Team Inbox thread’s items never appear here (and contact erasure leaves Postbox mail alone).';
const PURGE_JOB =
	'A running thread brief purge job (schema/threadPurgeJobs.ts): ids only, no content; it deletes itself when its walk ends, and a walk over an erased row finds nothing.';
const CLAIM_RECORD =
	'A source’s claim record (ids only): deleted with the thread by its conversationThreadId; a message purge drops the entries of the claims it deleted (purge.ts claimRecordsRange).';
const DANGLING =
	'An item id and nothing else; the question text is the message’s own. Readers resolve the item and treat a missing one as unlinked.';

const relation = (
	parent: TableNames,
	table: TableNames,
	field: string,
	action: ErasureAction,
	why: string,
	deletesWhen?: string
): DescendantRelation => ({
	parent,
	table,
	field,
	action,
	why,
	...(deletesWhen ? { deletesWhen } : {}),
});

export const THREAD_BRIEF_CONTACT_DESCENDANTS: readonly DescendantRelation[] = [
	...THREAD_BRIEF_TABLES.map((table) =>
		table === 'threadFacts'
			? relation(
					'conversationThreads',
					table,
					'conversationThreadId',
					'retain',
					'Facts are written for Postbox mail threads only (brief mode); no Team Inbox thread has any, and the table has no team index.'
				)
			: relation('conversationThreads', table, 'conversationThreadId', 'delete', WITH_THREAD)
	),

	relation('conversationThreads', 'threadPurgeJobs', 'conversationThreadId', 'retain', PURGE_JOB),
	relation('inboundMessages', 'threadPurgeJobs', 'sources[].id', 'retain', PURGE_JOB),
	relation('inboundMessages', 'threadPurgeJobs', 'inboundMessageId', 'retain', PURGE_JOB),

	// ── inboundMessages (the contact's received mail) ──
	relation(
		'inboundMessages',
		'messageInterpretations',
		'source.id',
		'delete',
		'The model’s reading of the message (sealed proposals); deleted with it.'
	),
	relation(
		'inboundMessages',
		'interpretSources',
		'source.id',
		'delete',
		'The message’s eligibility signals, kept for interpretation retries; deleted with it.'
	),
	relation(
		'inboundMessages',
		'threadItems',
		'evidence[].source.id',
		'unlink',
		'The evidence entry quotes the message and goes with it; the item stays on the evidence other messages give it.',
		'the erased message was the item’s only evidence'
	),
	relation(
		'inboundMessages',
		'threadItems',
		'pendingUpdate.evidence[].source.id',
		'unlink',
		'An unconfirmed update’s evidence entry quotes the message and goes with it; the update goes when none is left.',
		'the erased message was the item’s only evidence'
	),
	relation(
		'inboundMessages',
		'threadFacts',
		'evidence[].source.id',
		'retain',
		'Facts exist on Postbox mail threads only (brief mode); a Team Inbox message never evidences one.'
	),
	relation(
		'inboundMessages',
		'draftResponsePlans',
		'inboundMessageId',
		'delete',
		'The response plan of the draft the message carried.'
	),

	// ── threadItems ──
	relation(
		'threadItems',
		'mailThreads',
		'needsReply.clarification.questions[].itemId',
		'retain',
		MAIL_ONLY
	),
	relation('threadItems', 'mailThreads', 'briefTop.top.itemId', 'retain', MAIL_ONLY),
	relation(
		'threadItems',
		'mailCommitments',
		'threadItemId',
		'unlink',
		'A commitment is the mailbox’s; it loses the link to the deleted item.'
	),
	relation(
		'threadItems',
		'inboundMessages',
		'pendingClarification.questions[].itemId',
		'retain',
		DANGLING
	),
	relation(
		'threadItems',
		'threadNotes',
		'threadItemId',
		'unlink',
		'A team note about the item loses the link; the note is deleted with its thread when that is the contact’s.'
	),
	relation(
		'threadItems',
		'chatMessages',
		'threadItemId',
		'unlink',
		'A Postbox discussion message is the team’s; it loses the link to the deleted item.'
	),
	relation('threadItems', 'answerAskSessions', 'questions[].itemId', 'retain', DANGLING),
	relation('threadItems', 'threadItems', 'replacedById', 'retain', IN_THREAD),
	relation('threadItems', 'threadItems', 'possibleDuplicateOfId', 'retain', IN_THREAD),
	relation(
		'threadItems',
		'threadActivity',
		'itemId',
		'delete',
		'The activity about a deleted item goes with it.'
	),
	relation(
		'threadItems',
		'threadItemCorrections',
		'itemId',
		'delete',
		'An eval correction of a deleted item goes with it.'
	),
	relation('threadItems', 'threadActivity', 'delta.replacedById', 'retain', IN_THREAD),
	relation('threadItems', 'interpretSources', 'claimIds[].itemId', 'retain', CLAIM_RECORD),
	relation('threadItems', 'draftResponsePlans', 'itemRevisions[].itemId', 'retain', IN_THREAD),
	relation('threadItems', 'draftResponsePlans', 'stances[].itemId', 'retain', IN_THREAD),
	relation('threadItems', 'draftResponsePlans', 'ownerInputs[].itemId', 'retain', IN_THREAD),
	relation('threadItems', 'draftResponsePlans', 'coverage[].itemId', 'retain', IN_THREAD),

	// ── messageInterpretations ──
	relation(
		'messageInterpretations',
		'threadBriefs',
		'checkpoint.interpretationId',
		'retain',
		IN_THREAD
	),
];
