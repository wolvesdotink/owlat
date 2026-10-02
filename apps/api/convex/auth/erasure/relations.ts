/**
 * Member erasure relation policy — the declared fate, when an account is
 * erased, of every row that names the member, of every row under a personal
 * mailbox, and of every row that points at something the erasure deletes.
 *
 * Pure data. The cascade itself is the phases in `identityPhases.ts`,
 * `mailboxPhases.ts` and `memberPhases.ts`; this file is the contract they
 * implement; `descendantRelations.ts` holds the second half of the data.
 * `__tests__/memberErasureRelations.test.ts` walks both schemas so
 * a new relation cannot land without a declaration here:
 *
 *   - every string field named like a user id (`MEMBER_REFERENCE_FIELD`)
 *     anywhere in the schema must appear in `MEMBER_RELATIONS`;
 *   - every field that references a table the erasure deletes rows from
 *     (`mailboxes` included) must appear in `DESCENDANT_RELATIONS`,
 *     recursively;
 *   - every BetterAuth component table must appear in `IDENTITY_TABLES`.
 *
 * The actions:
 *   - `delete` — the member's own data, or meaningless without its parent. It
 *     goes, with any blob it owns. For a mailbox relation this applies to the
 *     member's PERSONAL mailboxes; team inboxes and seeds they connected are
 *     organization infrastructure and are never erased with one member.
 *   - `anonymize` — the organization keeps the row; the member's id on it is
 *     replaced with '[deleted account]'.
 *   - `retain` — the row stays as it is. `why` says why that is lawful and
 *     safe: typically an organization record whose attribution is an opaque id
 *     that no longer resolves to a person once the profile and login identity
 *     are gone, or a row with its own short retention.
 */

import type { TableNames } from '../../_generated/dataModel';
import type { tables as betterAuthTables } from '../../betterAuth/schema';
import {
	DESCENDANT_RELATIONS,
	type MemberErasureAction,
	type MemberRelation,
} from './descendantRelations';

export type {
	DescendantRelation,
	MemberErasureAction,
	MemberRelation,
} from './descendantRelations';
export { DESCENDANT_RELATIONS } from './descendantRelations';

/** Field names that hold a BetterAuth user id, by the schema's naming. */
export const MEMBER_REFERENCE_FIELD =
	/^(?:userId|ownerId|memberId|authorId|assignedTo)$|(?:UserIds?|MemberId|By)$/;

const ORG_ATTRIBUTION =
	'Organization record of who did something; the id no longer resolves to a person once the profile and login identity are gone.';

function rel(table: TableNames, field: string, action: MemberErasureAction, why: string) {
	return { table, field, action, why };
}

/** Every string field in the schema named like a user id. */
export const MEMBER_RELATIONS: readonly MemberRelation[] = [
	rel(
		'userProfiles',
		'authUserId',
		'delete',
		'The profile: name, email, locale. Deleted when the erasure starts.'
	),
	rel('userProfiles', 'deletedBy', 'retain', ORG_ATTRIBUTION),
	rel(
		'accountDeletionRequests',
		'authUserId',
		'retain',
		'The deletion record itself; it has to name what was erased to be resumable and auditable.'
	),
	rel(
		'memberErasureJobs',
		'authUserId',
		'delete',
		'The job row is deleted when the erasure completes.'
	),
	rel('onboardingProgress', 'userId', 'delete', 'Per-user onboarding state.'),
	rel('userOnboarding', 'authUserId', 'delete', 'Per-user onboarding checklist.'),
	rel('sendReadyNotices', 'userId', 'delete', 'Nudges addressed to the member.'),
	rel(
		'platformAdmins',
		'authUserId',
		'delete',
		'Deployment-level power and an email; must not outlive the person.'
	),
	rel(
		'mailboxes',
		'userId',
		'delete',
		'Personal mailboxes go with all their mail. Team inboxes and seeds keep their custodian id until an admin reassigns or retires them.'
	),
	rel(
		'mailboxMembers',
		'authUserId',
		'delete',
		'Grants on other mailboxes. The owner row on a team inbox or seed the member still owns stays, or the mailbox would be orphaned.'
	),
	rel('mailboxMembers', 'addedBy', 'retain', ORG_ATTRIBUTION),
	rel('pendingMailboxMembers', 'invitedByUserId', 'retain', ORG_ATTRIBUTION),
	rel(
		'pendingMailboxes',
		'acceptedByUserId',
		'delete',
		'A reservation the member accepted would otherwise be provisioned for the erased id when its domain verifies.'
	),
	rel('pendingMailboxes', 'createdByUserId', 'retain', ORG_ATTRIBUTION),
	rel(
		'mailboxRequests',
		'authUserId',
		'delete',
		'Carries the requester’s email, name and free-text note.'
	),
	rel('mailboxRequests', 'resolvedByUserId', 'retain', ORG_ATTRIBUTION),
	rel(
		'accessRequests',
		'authUserId',
		'delete',
		'Carries the requester’s email, name and free-text note.'
	),
	rel('accessRequests', 'resolvedByUserId', 'retain', ORG_ATTRIBUTION),
	rel(
		'externalMailAccounts',
		'userId',
		'delete',
		'Encrypted IMAP/SMTP credentials of personal accounts. Team-inbox and seed accounts are org infrastructure and stay with their mailboxes.'
	),
	rel(
		'externalMailOAuthStates',
		'userId',
		'delete',
		'OAuth handshakes in flight, with their code verifiers.'
	),
	rel(
		'externalMailOAuthStates',
		'intent.memberUserIds[]',
		'retain',
		'Another admin’s handshake that would grant the member access; it expires within minutes and grants nothing to an id with no membership.'
	),
	rel(
		'mailboxMigrations',
		'userId',
		'delete',
		'Imports from a personal external account; deleted with that account.'
	),
	rel('mailboxMoves', 'userId', 'delete', 'Moves of the member’s own external mailbox.'),
	rel(
		'mailArchiveImports',
		'userId',
		'delete',
		'Imports into a personal mailbox go with their uploaded archive. One into a team inbox is the team’s import and stays.'
	),
	rel(
		'mailAttachmentShares',
		'userId',
		'delete',
		'Links out of a personal mailbox go with their file. A link from a team inbox is the team’s; it lapses at its expiry and the team can revoke it.'
	),
	rel('mailAppPasswords', 'userId', 'delete', 'Credentials.'),
	rel('mailUserSettings', 'userId', 'delete', 'Personal preferences.'),
	rel('mailBriefCards', 'userId', 'delete', 'The member’s own greeting cards, on any mailbox.'),
	rel('mailThreadVisits', 'userId', 'delete', 'Reading history.'),
	rel('todayStates', 'userId', 'delete', 'Personal Today state.'),
	rel('threadPresence', 'userId', 'delete', 'Live presence.'),
	rel('emailEditorPresence', 'userId', 'delete', 'Live email-editor presence.'),
	rel(
		'emailCoeditNotices',
		'replacedBy',
		'delete',
		'A transient co-editing notice naming who replaced a change; it has no use once that person is gone.'
	),
	rel('threadReads', 'userId', 'delete', 'Read markers.'),
	rel('inboxAssignmentNotices', 'userId', 'delete', 'Notices addressed to the member.'),
	rel('dashboardLayouts', 'userId', 'delete', 'Personal layout.'),
	rel(
		'accountExportSessions',
		'userId',
		'delete',
		'Staged exports of the member’s data, with their files.'
	),
	rel(
		'aiConversations',
		'ownerId',
		'delete',
		'Private assistant conversations, including soft-deleted ones.'
	),
	rel(
		'aiMessages',
		'ownerId',
		'delete',
		'Private assistant transcripts; deleted through their conversation.'
	),
	rel(
		'aiDraftStreams',
		'ownerId',
		'delete',
		'Leftover draft-revise buffers holding the member’s draft text.'
	),
	rel(
		'answerAskSessions',
		'ownerId',
		'delete',
		'Answer mode ask sessions: the member’s instruction and answers, and thread text quoted for the drafter. Private to their owner whatever the target, so the member’s go from team threads and shared mailboxes too; other members’ sessions stay.'
	),
	rel(
		'chatMessages',
		'authorId',
		'anonymize',
		'Team-chat messages stay so the room keeps its flow; the authorship goes.'
	),
	rel('chatRoomMembers', 'memberId', 'delete', 'Room memberships.'),
	rel('chatMentions', 'mentionedMemberId', 'delete', 'The member’s unread mentions.'),
	rel(
		'chatMentions',
		'mentioningMemberId',
		'retain',
		'Another member’s unread marker; the message it points at is anonymized.'
	),
	rel('chatRooms', 'createdBy', 'retain', ORG_ATTRIBUTION),
	rel(
		'deliverabilityAlertRecipients',
		'userId',
		'anonymize',
		'The organization’s notification ledger; anything still owed to the member is cancelled.'
	),
	rel(
		'deliverabilityAlertRecipientReceipts',
		'userId',
		'anonymize',
		'Compacted outcomes of the ledger above.'
	),
	rel(
		'auditLogs',
		'userId',
		'retain',
		'The organization’s accountability trail; aged out after 30 days (maintenance/retention.ts).'
	),
	rel(
		'storageUploads',
		'userId',
		'retain',
		'Upload receipts. Those of files the erasure deletes go with the file, including Reply Queue answer uploads bound to a personal thread (resource key `mailThreads:<id>`); the rest are deletion authority for the organization’s resources, and unclaimed tickets expire.'
	),
	rel(
		'counterScopes',
		'ownerId',
		'delete',
		'Not a user id: the mailbox or folder a counter scope belongs to. Cleared with the personal mailbox and its folders.'
	),
	rel(
		'mailMessages',
		'sentByUserId',
		'retain',
		'Deleted with a personal mailbox; in a team inbox it is organization mail attribution.'
	),
	rel(
		'mailDrafts',
		'sentByUserId',
		'retain',
		'Deleted with a personal mailbox; in a team inbox it is organization mail attribution.'
	),
	rel(
		'mailThreads',
		'latestReply.byUserId',
		'retain',
		'Deleted with a personal mailbox; in a team inbox it is organization mail attribution.'
	),
	rel('conversationThreads', 'assignedTo', 'retain', ORG_ATTRIBUTION),
	rel('inboundMessages', 'assignedTo', 'retain', ORG_ATTRIBUTION),
	rel('inboundMessages', 'draftRevisions[].savedBy', 'retain', ORG_ATTRIBUTION),
	rel(
		'unifiedMessages',
		'memberId',
		'retain',
		'Organization correspondence with a contact; the member is only the internal sender.'
	),
	rel('inboxFollowUps', 'createdBy', 'retain', ORG_ATTRIBUTION),
	rel('conversationThreads', 'replyAttachments[].addedBy', 'retain', ORG_ATTRIBUTION),
	rel('inboundMessages', 'replyAttachments[].addedBy', 'retain', ORG_ATTRIBUTION),
	rel('inboxFollowUps', 'attachments[].addedBy', 'retain', ORG_ATTRIBUTION),
	rel('shareLinks', 'createdBy', 'retain', ORG_ATTRIBUTION),
	rel('visualizations', 'createdBy', 'retain', ORG_ATTRIBUTION),
	rel('campaignSenders', 'createdBy', 'retain', ORG_ATTRIBUTION),
	rel('emailTemplateVersions', 'createdBy', 'retain', ORG_ATTRIBUTION),
	rel('mediaAssets', 'uploadedBy', 'retain', ORG_ATTRIBUTION),
	rel('semanticFiles', 'uploadedBy', 'retain', ORG_ATTRIBUTION),
	rel('connectedApps', 'createdByUserId', 'retain', ORG_ATTRIBUTION),
	rel(
		'pluginLlmReservations',
		'actorUserId',
		'retain',
		'Short-lived usage reservations released by their own sweep.'
	),
	rel('rampStreamPresets', 'updatedByUserId', 'retain', ORG_ATTRIBUTION),
	rel('recipientKeys', 'verifiedBy', 'retain', ORG_ATTRIBUTION),
	rel(
		'automationRuns',
		'triggeredBy',
		'retain',
		'Not a user id: the trigger type that started the run.'
	),
	rel('knowledgeBackfillJobs', 'triggeredBy', 'retain', ORG_ATTRIBUTION),
	rel('knowledgeEdgeBackfillJobs', 'triggeredBy', 'retain', ORG_ATTRIBUTION),
	rel('contactPropertyDeletionJobs', 'requestedBy', 'retain', ORG_ATTRIBUTION),
	rel('contacts', 'deletedBy', 'retain', ORG_ATTRIBUTION),
	rel('emailSends', 'deletedBy', 'retain', ORG_ATTRIBUTION),
	rel('transactionalSends', 'deletedBy', 'retain', ORG_ATTRIBUTION),
	rel('instanceSettings', 'abuseStatusChangedBy', 'retain', ORG_ATTRIBUTION),
	rel('instanceSettings', 'desktopUpdates.updatedBy', 'retain', ORG_ATTRIBUTION),
	rel('backupState', 'updatedBy', 'retain', ORG_ATTRIBUTION),
	rel('systemUpdates', 'initiatedBy', 'retain', ORG_ATTRIBUTION),
	rel('workspaceDeletionJobs', 'requestedBy', 'retain', 'The workspace deletion’s own history.'),
	rel('workspaceDeletionJobs', 'abortedBy', 'retain', 'The workspace deletion’s own history.'),
];

type BetterAuthTable = keyof typeof betterAuthTables;

/**
 * Every BetterAuth component table. `delete` rows are removed for the member
 * by `identityPhases.ts`; the end-state check requires the user, session,
 * account, passkey, two-factor and member rows to be gone.
 */
export const IDENTITY_TABLES = {
	user: {
		action: 'delete',
		why: 'The login identity: name, email. Removed when the erasure starts, which ends every session.',
	},
	session: { action: 'delete', why: 'Session tokens, IP and user agent.' },
	account: { action: 'delete', why: 'The password hash and any linked provider tokens.' },
	passkey: { action: 'delete', why: 'Registered passkeys.' },
	twoFactor: { action: 'delete', why: 'TOTP secret and backup codes.' },
	member: { action: 'delete', why: 'Organization membership.' },
	oauthApplication: {
		action: 'delete',
		why: 'Applications the member registered (provider plugin not enabled here).',
	},
	oauthAccessToken: {
		action: 'delete',
		why: 'Tokens issued to the member (provider plugin not enabled here).',
	},
	oauthConsent: {
		action: 'delete',
		why: 'Consents the member gave (provider plugin not enabled here).',
	},
	verification: {
		action: 'delete',
		why: 'Unexpired records naming the member (a password-reset token stores the user id). Expired ones are inert.',
	},
	invitation: {
		action: 'delete',
		why: 'Decided invitations addressed to the member. Pending ones are the organization’s standing intent for the address; `inviterId` on invitations the member sent is organization attribution and stays.',
	},
	organization: {
		action: 'retain',
		why: 'The organization; deleted only by an owner’s workspace deletion, never with one member.',
	},
	jwks: { action: 'retain', why: 'Instance signing keys.' },
	rateLimit: {
		action: 'retain',
		why: 'Keyed by client address and path, not by user; entries age out.',
	},
} as const satisfies Record<BetterAuthTable, { action: MemberErasureAction; why: string }>;

/** Tables the erasure deletes rows from: the parents whose references must be declared. */
export function tablesErasureDeletesFrom(): Set<TableNames> {
	const tables = new Set<TableNames>();
	for (const relation of [...MEMBER_RELATIONS, ...DESCENDANT_RELATIONS]) {
		if (relation.action === 'delete') tables.add(relation.table);
	}
	return tables;
}
