/**
 * Member erasure relation policy, part two: every field that references a
 * table the erasure deletes rows from — above all the member's PERSONAL
 * mailboxes and everything under them. Split out of `relations.ts` (which holds
 * the rules and the fields that name the member) to keep both files readable;
 * the coverage test reads the two together.
 */

import type { TableNames } from '../../_generated/dataModel';

export type MemberErasureAction = 'delete' | 'anonymize' | 'retain';

export interface MemberRelation {
	table: TableNames;
	/** Field path: `userId`, `ids[]` for an array element, `a.b[].c` nested. */
	field: string;
	action: MemberErasureAction;
	why: string;
}

export interface DescendantRelation extends MemberRelation {
	/** The table whose deleted rows this field points at. */
	parent: TableNames;
}

const WITH_MAILBOX = 'Part of the personal mailbox; deleted with it.';
const SAME_MAILBOX = 'Points within the same personal mailbox, whose rows are all deleted.';

function desc(
	parent: TableNames,
	table: TableNames,
	field: string,
	action: MemberErasureAction,
	why: string
): DescendantRelation {
	return { parent, table, field, action, why };
}

/** Every field that references a table the erasure deletes rows from. */
export const DESCENDANT_RELATIONS: readonly DescendantRelation[] = [
	desc('mailboxes', 'mailboxUsage', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailboxMembers', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'pendingMailboxMembers', 'mailboxId', 'delete', WITH_MAILBOX),
	desc(
		'mailboxes',
		'mailboxRequests',
		'fulfilledMailboxId',
		'retain',
		'The member’s own requests are deleted by user id; another request fulfilled with the mailbox keeps a dangling id only.'
	),
	desc(
		'mailboxes',
		'externalMailAccounts',
		'mailboxId',
		'delete',
		'The personal account behind the mailbox, with its credentials.'
	),
	desc(
		'mailboxes',
		'externalMailOAuthStates',
		'intent.mailboxId',
		'delete',
		'The member’s own handshakes are deleted; they expire within minutes regardless.'
	),
	desc(
		'mailboxes',
		'externalMailFolderSync',
		'mailboxId',
		'delete',
		'Sync state; deleted with the account.'
	),
	desc(
		'mailboxes',
		'mailboxMigrations',
		'mailboxId',
		'delete',
		'Deleted with the personal external account they import from.'
	),
	desc(
		'mailboxes',
		'mailArchiveImports',
		'mailboxId',
		'delete',
		'Stopped first, then deleted with the uploaded archive.'
	),
	desc('mailboxes', 'mailboxMoves', 'sourceMailboxId', 'delete', 'The member’s own move.'),
	desc('mailboxes', 'mailboxMoves', 'hostedMailboxId', 'delete', 'The member’s own move.'),
	desc('mailboxes', 'mailFolders', 'mailboxId', 'delete', WITH_MAILBOX),
	desc(
		'mailboxes',
		'mailMessages',
		'mailboxId',
		'delete',
		'Mail, with bodies, attachment index rows and unshared blobs.'
	),
	desc('mailboxes', 'mailThreads', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailLabels', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailSavedSearches', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailDrafts', 'mailboxId', 'delete', 'Drafts, with their attachment files.'),
	desc(
		'mailboxes',
		'mailDrafts',
		'sendAsMailboxId',
		'retain',
		'A draft in another mailbox is that mailbox’s; a vanished send-as identity fails validation at send.'
	),
	desc('mailboxes', 'mailAttachments', 'mailboxId', 'delete', WITH_MAILBOX),
	desc(
		'mailboxes',
		'mailAttachmentBackfillJobs',
		'mailboxId',
		'delete',
		'Stopped before the mail goes.'
	),
	desc(
		'mailboxes',
		'mailBodySearchBackfillJobs',
		'mailboxId',
		'delete',
		'Stopped before the mail goes.'
	),
	desc(
		'mailboxes',
		'mailAttachmentShares',
		'mailboxId',
		'delete',
		'Links, with the file each one serves.'
	),
	desc('mailboxes', 'mailSignatures', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailSnippets', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailFilters', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailFilterRunJobs', 'mailboxId', 'delete', 'Stopped before the mail goes.'),
	desc('mailboxes', 'mailAliases', 'targetMailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailForwarding', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailVacationResponders', 'mailboxId', 'delete', WITH_MAILBOX),
	desc('mailboxes', 'mailVacationLog', 'mailboxId', 'delete', 'Correspondents’ addresses.'),
	desc('mailboxes', 'mailAppPasswords', 'mailboxId', 'delete', 'Credentials.'),
	desc(
		'mailboxes',
		'mailAuditLog',
		'mailboxId',
		'retain',
		'Security trail of mailbox access; aged out after 30 days (maintenance/retention.ts).'
	),
	desc('mailboxes', 'mailContacts', 'mailboxId', 'delete', 'The private address book.'),
	desc(
		'mailboxes',
		'mailSenderCategoryOverrides',
		'mailboxId',
		'delete',
		'Per-sender preferences.'
	),
	desc('mailboxes', 'mailSenderImageAllowlist', 'mailboxId', 'delete', 'Per-sender preferences.'),
	desc('mailboxes', 'mailTriageTallies', 'mailboxId', 'delete', 'Per-sender reading behaviour.'),
	desc('mailboxes', 'mailContactStyleOverrides', 'mailboxId', 'delete', 'Learned writing style.'),
	desc('mailboxes', 'mailVoiceProfiles', 'mailboxId', 'delete', 'Learned writing style.'),
	desc('mailboxes', 'mailCommitments', 'mailboxId', 'delete', 'Extracted from the member’s mail.'),
	desc('mailboxes', 'mailDailyBriefs', 'mailboxId', 'delete', 'Digests of the member’s mail.'),
	desc('mailboxes', 'mailBriefCards', 'mailboxId', 'delete', WITH_MAILBOX),
	desc(
		'mailboxes',
		'todayStates',
		'hiddenMailboxIds[]',
		'retain',
		'The member’s own Today state is deleted; nobody else can see a personal mailbox, so no one else’s names it.'
	),
	desc('mailboxes', 'todayStates', 'marks[].key', 'retain', 'As above.'),
	desc(
		'mailboxes',
		'mailThreadVisits',
		'mailboxId',
		'delete',
		'Deleted by user id; only the owner reads a personal mailbox.'
	),
	desc('mailMessages', 'mailboxMigrations', 'indexCursorId', 'delete', 'Deleted with the import.'),
	desc(
		'mailMessages',
		'mailMessageBodies',
		'messageId',
		'delete',
		'The inline body; deleted with its message.'
	),
	desc('mailMessages', 'mailThreads', 'latestMessageId', 'delete', SAME_MAILBOX),
	desc('mailMessages', 'mailThreads', 'latestReply.messageId', 'delete', SAME_MAILBOX),
	desc('mailMessages', 'mailThreads', 'needsReply.messageId', 'delete', SAME_MAILBOX),
	desc('mailMessages', 'mailThreads', 'followUp.messageId', 'delete', SAME_MAILBOX),
	desc('mailMessages', 'mailDrafts', 'linkedMessageId', 'delete', SAME_MAILBOX),
	desc('mailMessages', 'mailDrafts', 'inReplyToMessageId', 'delete', SAME_MAILBOX),
	desc(
		'mailMessages',
		'mailAttachments',
		'messageId',
		'delete',
		'Attachment index rows go with their message.'
	),
	desc('mailMessages', 'mailAttachmentShares', 'sourceMessageId', 'delete', SAME_MAILBOX),
	desc('mailMessages', 'mailCommitments', 'messageId', 'delete', SAME_MAILBOX),
	desc('mailThreads', 'mailMessages', 'threadId', 'delete', SAME_MAILBOX),
	desc('mailThreads', 'mailDrafts', 'threadId', 'delete', SAME_MAILBOX),
	desc('mailThreads', 'mailCommitments', 'threadId', 'delete', SAME_MAILBOX),
	desc('mailThreads', 'mailDailyBriefs', 'items[].threadId', 'delete', SAME_MAILBOX),
	desc('mailThreads', 'mailDailyBriefs', 'bundled[].threadId', 'delete', SAME_MAILBOX),
	desc(
		'mailThreads',
		'mailThreadVisits',
		'threadId',
		'delete',
		'Deleted by user id; only the owner reads a personal mailbox.'
	),
	desc(
		'mailThreads',
		'todayThreadSummaries',
		'threadId',
		'delete',
		'One-sentence digests of the thread’s content; deleted before the thread.'
	),
	desc(
		'mailThreads',
		'clarificationAskLog',
		'threadId',
		'retain',
		'Calibration counts with no content; a dangling thread id identifies nothing.'
	),
	desc(
		'mailThreads',
		'chatRooms',
		'linkedMailThreadId',
		'retain',
		'A team discussion room is the organization’s; the link dangles.'
	),
	desc('mailFolders', 'externalMailFolderSync', 'folderId', 'delete', SAME_MAILBOX),
	desc('mailFolders', 'mailFolders', 'parentId', 'delete', SAME_MAILBOX),
	desc('mailFolders', 'mailMessages', 'folderId', 'delete', SAME_MAILBOX),
	desc('mailFolders', 'mailMessages', 'snoozedFromFolderId', 'delete', SAME_MAILBOX),
	desc('mailFolders', 'mailAttachments', 'folderId', 'delete', SAME_MAILBOX),
	desc('mailFolders', 'mailFilters', 'actions[].folderId', 'delete', SAME_MAILBOX),
	desc('mailLabels', 'mailMessages', 'labelIds[]', 'delete', SAME_MAILBOX),
	desc('mailLabels', 'mailThreads', 'labelIds[]', 'delete', SAME_MAILBOX),
	desc('mailLabels', 'mailLabels', 'parentId', 'delete', SAME_MAILBOX),
	desc('mailLabels', 'mailFilters', 'actions[].labelId', 'delete', SAME_MAILBOX),
	desc('mailDrafts', 'mailAttachmentShares', 'sourceDraftId', 'delete', SAME_MAILBOX),
	desc('mailFilters', 'mailFilterRunJobs', 'filterId', 'delete', SAME_MAILBOX),
	desc('mailFilters', 'mailTriageTallies', 'actedFilterId', 'delete', SAME_MAILBOX),
	desc(
		'externalMailAccounts',
		'mailboxes',
		'externalAccountId',
		'delete',
		'The personal mailbox the account feeds.'
	),
	desc(
		'externalMailAccounts',
		'externalMailAccessTokens',
		'accountId',
		'delete',
		'Cached OAuth access token.'
	),
	desc('externalMailAccounts', 'externalMailFolderSync', 'accountId', 'delete', 'Sync state.'),
	desc(
		'externalMailAccounts',
		'externalMailRemoteOps',
		'accountId',
		'delete',
		'Queued write-backs carrying the member’s Message-IDs.'
	),
	desc('externalMailAccounts', 'mailboxMigrations', 'accountId', 'delete', 'Import records.'),
	desc('externalMailAccounts', 'mailboxMoves', 'accountId', 'delete', 'Move records.'),
	desc(
		'externalMailAccounts',
		'seedPlacementProbes',
		'accountId',
		'retain',
		'Only seed accounts are probed, and seeds are organization infrastructure the erasure keeps.'
	),
	desc('mailboxRequests', 'mailboxMoves', 'provisionRequestId', 'delete', 'The member’s own move.'),
	desc(
		'aiConversations',
		'aiMessages',
		'conversationId',
		'delete',
		'Turns go before their conversation.'
	),
	desc(
		'accountExportSessions',
		'accountExportArtifacts',
		'sessionId',
		'delete',
		'Staged files of the export.'
	),
	desc(
		'accountExportSessions',
		'accountExportArtifactLeases',
		'sessionId',
		'delete',
		'Download capabilities of the export.'
	),
	desc(
		'accountExportArtifacts',
		'accountExportArtifactLeases',
		'artifactId',
		'delete',
		'Deleted before their artifacts.'
	),
	desc(
		'userProfiles',
		'accountDeletionRequests',
		'userProfileId',
		'retain',
		'The deletion record outlives the profile it deleted.'
	),
];
