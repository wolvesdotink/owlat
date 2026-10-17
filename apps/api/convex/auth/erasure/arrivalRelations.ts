/**
 * Member erasure policy for the read-on-arrival tables (schema/mailArrival.ts)
 * and the fields the plan adds to `mailThreads`, spread into
 * `DESCENDANT_RELATIONS` (descendantRelations.ts). Every row is scoped to one
 * mailbox and goes with a personal one: the `mailboxMessages` phase takes the
 * per-message rows with each message (`mail/arrival/purge.ts`), the
 * `mailboxRecords` phase the rest (`arrivalPhases.ts`).
 */

import type { TableNames } from '../../_generated/dataModel';
import type { DescendantRelation } from './descendantRelations';

const WITH_MAILBOX = 'Read on arrival state of the personal mailbox; deleted with it.';
const SAME_MAILBOX = 'Points within the same personal mailbox, whose rows are all deleted.';
const WITH_MESSAGE =
	'Deleted with its message (mail/arrival/purge.ts), and with the mailbox regardless.';

const del = (parent: TableNames, table: TableNames, field: string, why = SAME_MAILBOX) =>
	({ parent, table, field, action: 'delete', why }) satisfies DescendantRelation;

const OPERATION_REFS: ReadonlyArray<readonly [TableNames, string]> = [
	['mailArrivalRecords', 'lastOperationId'],
	['mailSenderProfiles', 'statusOperationId'],
	['mailSenderProfiles', 'placementOverrideOperationId'],
	['mailSenderProfiles', 'lastOperationId'],
	['mailArrivalOperationChanges', 'operationId'],
	['mailArrivalOperationChanges', 'change.before.operationId'],
	['mailArrivalOperationChanges', 'change.after.operationId'],
	['mailDelayedActions', 'createdByOperationId'],
	['mailDelayedActions', 'operationId'],
	['mailThreads', 'placementOverride.operationId'],
	['mailThreads', 'lastArrivalOperationId'],
];

const FILTER_REFS: ReadonlyArray<readonly [TableNames, string]> = [
	['mailArrivalRecords', 'filterMatches[].filterId'],
	['mailArrivalRecords', 'pendingAiFilters[].filterId'],
	['mailArrivalRecords', 'exclusiveWinners.folder.filterId'],
	['mailArrivalRecords', 'exclusiveWinners.section.filterId'],
	['mailArrivalRecords', 'exclusiveWinners.placement.filterId'],
	['mailArrivalOperations', 'filterId'],
	['mailDelayedActions', 'filterId'],
];

export const ARRIVAL_MEMBER_DESCENDANTS: readonly DescendantRelation[] = [
	...(
		[
			'mailArrivalRecords',
			'mailSenderProfiles',
			'mailArrivalOperations',
			'mailArrivalOperationChanges',
			'mailRuleDrafts',
			'mailDelayedActions',
			'mailDigests',
		] as const
	).map((table) => del('mailboxes', table, 'mailboxId', WITH_MAILBOX)),
	...OPERATION_REFS.map(([table, field]) => del('mailArrivalOperations', table, field)),
	...FILTER_REFS.map(([table, field]) => del('mailFilters', table, field)),

	del('mailMessages', 'mailArrivalRecords', 'messageId', WITH_MESSAGE),
	del('mailMessages', 'mailDelayedActions', 'messageId', WITH_MESSAGE),
	del('mailMessages', 'mailArrivalOperationChanges', 'messageId', WITH_MESSAGE),
	del('mailMessages', 'mailArrivalOperationChanges', 'change.messageId', WITH_MESSAGE),
	del('mailMessages', 'mailDigests', 'items[].messageId', WITH_MESSAGE),
	del('mailMessages', 'mailArrivalOperations', 'messageId'),
	del('mailMessages', 'mailRuleDrafts', 'fromMessageId'),
	del('mailMessages', 'mailDigests', 'sentMessageId'),
	del('mailMessages', 'mailThreads', 'arrival.messageId'),

	del('mailThreads', 'mailArrivalRecords', 'threadId'),
	del('mailThreads', 'mailArrivalOperations', 'threadId'),
	del('mailThreads', 'mailArrivalOperationChanges', 'change.threadId'),
	del('mailThreads', 'mailDelayedActions', 'threadId'),
	del('mailThreads', 'mailDigests', 'items[].threadId'),
	del('mailThreads', 'mailDigests', 'visited[].threadId'),

	del('mailFolders', 'mailArrivalOperationChanges', 'change.before'),
	del('mailFolders', 'mailArrivalOperationChanges', 'change.after'),
	del('mailFolders', 'mailDelayedActions', 'anchor.folderId'),
	del('mailFolders', 'mailRuleDrafts', 'preview.actions[].folderId'),

	del('mailLabels', 'mailArrivalOperationChanges', 'labelId'),
	del('mailLabels', 'mailArrivalOperationChanges', 'change.labelId'),
	del('mailLabels', 'mailRuleDrafts', 'preview.actions[].labelId'),
];
