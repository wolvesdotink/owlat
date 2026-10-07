/**
 * Member erasure policy for the thread brief tables (schema/threadBrief.ts),
 * spread into `DESCENDANT_RELATIONS` (descendantRelations.ts) and
 * `MEMBER_RELATIONS` (relations.ts).
 *
 * KNOWN GAP, declared as `retain` until the thread brief erasure lands: rows
 * under the member's personal mailboxes are derived from that mail and must go
 * with it. The erasure phases for them are part of the thread brief wiring;
 * that change flips each entry to `delete` together with its phase, which
 * `memberErasureRelations.test.ts` ("has a phase that reads every table it
 * declares deleted") then checks.
 */

import type { TableNames } from '../../_generated/dataModel';
import { THREAD_BRIEF_TABLES } from '../../schema/threadBrief';
import type { DescendantRelation, MemberRelation } from './descendantRelations';

const GAP =
	'Known gap (thread brief): derived from the personal mailbox’s mail; the erasure phase that deletes it lands with the thread brief wiring.';

const descendant = (parent: TableNames, table: TableNames, field: string): DescendantRelation => ({
	parent,
	table,
	field,
	action: 'retain',
	why: GAP,
});

export const THREAD_BRIEF_MEMBER_DESCENDANTS: readonly DescendantRelation[] = [
	...THREAD_BRIEF_TABLES.map((table) => descendant('mailThreads', table, 'mailThreadId')),
	descendant('mailboxes', 'threadItems', 'mailboxId'),
	descendant('mailMessages', 'messageInterpretations', 'source.id'),
	descendant('mailMessages', 'threadFacts', 'evidence[].source.id'),
	descendant('mailMessages', 'threadItems', 'evidence[].source.id'),
	descendant('mailDrafts', 'draftResponsePlans', 'mailDraftId'),
	descendant('mailCommitments', 'threadItems', 'commitmentId'),
];

export const THREAD_BRIEF_MEMBER_RELATIONS: readonly MemberRelation[] = [
	{
		table: 'threadItems',
		field: 'assigneeUserId',
		action: 'retain',
		why: 'Known gap (thread brief): a team item assigned to the member should fall back to Unassigned; the erasure step lands with the thread brief wiring.',
	},
	{
		table: 'noteReactions',
		field: 'userId',
		action: 'retain',
		why: 'Known gap (thread brief): the member’s emoji reactions on internal notes should go; the erasure step that deletes them lands with the thread brief wiring.',
	},
	{
		table: 'threadItemCorrections',
		field: 'userId',
		action: 'retain',
		why: 'Known gap (thread brief): who corrected an item, kept for the interpretation eval; the erasure step that anonymizes it lands with the thread brief wiring.',
	},
	{
		table: 'threadViewerState',
		field: 'userId',
		action: 'retain',
		why: 'Known gap (thread brief): the member’s own view state and "last seen" markers; the erasure step that deletes them lands with the thread brief wiring.',
	},
];
