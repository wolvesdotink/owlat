/**
 * Member erasure policy for tasks, member groups and the company index
 * (schema/tasks.ts, schema/companies.ts), spread into `MEMBER_RELATIONS`
 * (relations.ts) and `DESCENDANT_RELATIONS` (descendantRelations.ts). The
 * phases are in `taskPhases.ts`:
 *
 *  - each personal mailbox takes its company index rows and cursor with it,
 *    and a task taken from its mail loses the link to that conversation
 *    (`mailboxTaskLinks` phase, before the mailbox row goes);
 *  - the member's private tasks go; a task shared with everyone or a group is
 *    the team's work and stays, the member's id on it anonymized (`tasks`
 *    phase);
 *  - the member leaves every member group; who created a group or added
 *    someone to one is anonymized (`memberGroups` phase).
 */

import type { TableNames } from '../../_generated/dataModel';
import type {
	DescendantRelation,
	MemberErasureAction,
	MemberRelation,
} from './descendantRelations';

const COMPANY_INDEX =
	'Company index rows of a personal mailbox name who the member wrote to; deleted with the mailbox (mailboxTaskLinks phase).';
const TASK_SOURCE =
	'A task taken from the personal mailbox’s mail stays with whoever can see it; the link to the conversation is cleared, so nothing points into the erased mailbox (mailboxTaskLinks phase).';

const descendant = (
	parent: TableNames,
	table: TableNames,
	field: string,
	action: MemberErasureAction,
	why: string
): DescendantRelation => ({ parent, table, field, action, why });

export const TASK_MEMBER_DESCENDANTS: readonly DescendantRelation[] = [
	descendant('mailboxes', 'companyThreads', 'mailboxId', 'delete', COMPANY_INDEX),
	descendant('mailThreads', 'companyThreads', 'mailThreadId', 'delete', COMPANY_INDEX),
	descendant(
		'mailboxes',
		'companyIndexCursors',
		'mailboxId',
		'delete',
		'How far the company index read the personal mailbox; deleted with it (mailboxTaskLinks phase).'
	),
	descendant('mailboxes', 'tasks', 'sourceMailboxId', 'unlink', TASK_SOURCE),
	descendant('mailThreads', 'tasks', 'sourceMailThreadId', 'unlink', TASK_SOURCE),
	descendant('threadItems', 'tasks', 'sourceThreadItemId', 'unlink', TASK_SOURCE),
];

export const TASK_MEMBER_RELATIONS: readonly MemberRelation[] = [
	{
		table: 'tasks',
		field: 'createdBy',
		action: 'delete',
		why: 'The member’s private tasks are deleted. A task shared with everyone or a group is the team’s work and stays; its creator becomes [deleted account] (tasks phase).',
	},
	{
		table: 'tasks',
		field: 'assigneeUserId',
		action: 'anonymize',
		why: 'A shared task assigned to the member stays with its audience, assigned to [deleted account] until someone takes it (tasks phase). A private task’s assignee is its creator, so it went above.',
	},
	{
		table: 'tasks',
		field: 'completedBy',
		action: 'anonymize',
		why: 'Who finished a shared task becomes [deleted account] (tasks phase).',
	},
	{
		table: 'memberGroupMembers',
		field: 'userId',
		action: 'delete',
		why: 'The member’s group memberships (memberGroups phase).',
	},
	{
		table: 'memberGroupMembers',
		field: 'addedBy',
		action: 'anonymize',
		why: 'Who added someone to a group becomes [deleted account] (memberGroups phase).',
	},
	{
		table: 'memberGroups',
		field: 'createdBy',
		action: 'anonymize',
		why: 'The group is the organization’s and stays; who created it becomes [deleted account] (memberGroups phase).',
	},
	{
		table: 'companyThreads',
		field: 'ownerUserId',
		action: 'delete',
		why: 'Only rows of a personal mailbox carry its owner; they are deleted with the mailbox (mailboxTaskLinks phase).',
	},
];
