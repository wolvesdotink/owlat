/**
 * Member erasure policy for the thread brief tables (schema/threadBrief.ts),
 * spread into `DESCENDANT_RELATIONS` (descendantRelations.ts) and
 * `MEMBER_RELATIONS` (relations.ts). The phases are in `threadBriefPhases.ts`:
 *
 *  - every thread of a personal mailbox takes its thread brief rows with it
 *    (`eraseThreads` → `drainThreadBrief`), and a draft its response plans
 *    (`eraseDrafts` → `eraseDraftPlans`);
 *  - the member's own viewer state and note reactions go everywhere
 *    (`threadViewerState`, `noteReactions` phases), their item corrections
 *    are anonymized (`threadItemCorrections` phase), and the Team Inbox items
 *    assigned to them fall back to Unassigned (`threadItemAssignments`
 *    phase).
 */

import type { TableNames } from '../../_generated/dataModel';
import { THREAD_BRIEF_TABLES } from '../../schema/threadBrief';
import type {
	DescendantRelation,
	MemberErasureAction,
	MemberRelation,
} from './descendantRelations';

const WITH_THREAD =
	'Derived from the personal thread’s mail (items, facts, activity, plans, viewer state); deleted with the thread.';
const SAME_THREAD =
	'Points within the same personal thread, whose thread brief rows are all deleted.';
const TEAM_ONLY =
	'Team Inbox only: a personal mailbox’s items never appear here. A dangling id carries no content.';

const descendant = (
	parent: TableNames,
	table: TableNames,
	field: string,
	action: MemberErasureAction,
	why: string
): DescendantRelation => ({ parent, table, field, action, why });

export const THREAD_BRIEF_MEMBER_DESCENDANTS: readonly DescendantRelation[] = [
	...THREAD_BRIEF_TABLES.map((table) =>
		descendant('mailThreads', table, 'mailThreadId', 'delete', WITH_THREAD)
	),
	descendant('mailboxes', 'threadItems', 'mailboxId', 'delete', WITH_THREAD),
	descendant('mailMessages', 'messageInterpretations', 'source.id', 'delete', WITH_THREAD),
	descendant(
		'mailMessages',
		'interpretSources',
		'source.id',
		'delete',
		'The message’s eligibility signals (and a sent reply’s snapshot); deleted with it.'
	),
	descendant('mailMessages', 'threadFacts', 'evidence[].source.id', 'delete', WITH_THREAD),
	descendant('mailMessages', 'threadItems', 'evidence[].source.id', 'delete', WITH_THREAD),
	descendant(
		'mailMessages',
		'threadItems',
		'pendingUpdate.evidence[].source.id',
		'delete',
		WITH_THREAD
	),
	descendant(
		'mailDrafts',
		'draftResponsePlans',
		'mailDraftId',
		'delete',
		'The draft’s response plan; deleted before the draft (and with its thread).'
	),
	descendant('mailCommitments', 'threadItems', 'commitmentId', 'delete', WITH_THREAD),

	// ── threadItems ──
	descendant(
		'threadItems',
		'mailThreads',
		'needsReply.clarification.questions[].itemId',
		'delete',
		SAME_THREAD
	),
	descendant('threadItems', 'mailThreads', 'briefTop.top.itemId', 'delete', SAME_THREAD),
	descendant(
		'threadItems',
		'mailCommitments',
		'threadItemId',
		'delete',
		'The personal mailbox’s commitments are deleted with it.'
	),
	descendant(
		'threadItems',
		'inboundMessages',
		'pendingClarification.questions[].itemId',
		'retain',
		TEAM_ONLY
	),
	descendant('threadItems', 'threadNotes', 'threadItemId', 'retain', TEAM_ONLY),
	descendant(
		'threadItems',
		'chatMessages',
		'threadItemId',
		'anonymize',
		'A thread’s discussion room is the organization’s and stays; its messages lose the link to the deleted item (unlinkDeletedItem).'
	),
	descendant(
		'threadItems',
		'answerAskSessions',
		'questions[].itemId',
		'delete',
		'Ask sessions on the mailbox’s drafts are deleted with the drafts; a Team Inbox session never names a personal item.'
	),
	descendant('threadItems', 'threadItems', 'replacedById', 'delete', SAME_THREAD),
	descendant('threadItems', 'threadItems', 'possibleDuplicateOfId', 'delete', SAME_THREAD),
	descendant('threadItems', 'threadActivity', 'itemId', 'delete', SAME_THREAD),
	descendant('threadItems', 'threadItemCorrections', 'itemId', 'delete', SAME_THREAD),
	descendant('threadItems', 'threadActivity', 'delta.replacedById', 'delete', SAME_THREAD),
	descendant('threadItems', 'draftResponsePlans', 'itemRevisions[].itemId', 'delete', SAME_THREAD),
	descendant('threadItems', 'draftResponsePlans', 'stances[].itemId', 'delete', SAME_THREAD),
	descendant('threadItems', 'draftResponsePlans', 'ownerInputs[].itemId', 'delete', SAME_THREAD),
	descendant('threadItems', 'draftResponsePlans', 'coverage[].itemId', 'delete', SAME_THREAD),

	// ── threadFacts ──
	descendant('threadFacts', 'threadFacts', 'supersedesId', 'delete', SAME_THREAD),
	descendant('threadFacts', 'threadFacts', 'conflictsWithId', 'delete', SAME_THREAD),
	descendant('threadFacts', 'threadActivity', 'delta.factId', 'delete', SAME_THREAD),

	// ── messageInterpretations ──
	descendant(
		'messageInterpretations',
		'threadBriefs',
		'checkpoint.interpretationId',
		'delete',
		SAME_THREAD
	),
];

export const THREAD_BRIEF_MEMBER_RELATIONS: readonly MemberRelation[] = [
	{
		table: 'threadItems',
		field: 'assigneeUserId',
		action: 'anonymize',
		why: 'A Team Inbox item assigned to the member is the organization’s and stays; the assignment is cleared, so it reads Unassigned (threadItemAssignments phase).',
	},
	{
		table: 'noteReactions',
		field: 'userId',
		action: 'delete',
		why: 'The member’s own emoji reactions on internal notes (noteReactions phase).',
	},
	{
		table: 'threadItemCorrections',
		field: 'userId',
		action: 'anonymize',
		why: 'The organization keeps the correction for the interpretation eval (structure only, no text); who made it becomes [deleted account] (threadItemCorrections phase).',
	},
	{
		table: 'threadViewerState',
		field: 'userId',
		action: 'delete',
		why: 'The member’s own view override and "last seen" markers (threadViewerState phase).',
	},
];
