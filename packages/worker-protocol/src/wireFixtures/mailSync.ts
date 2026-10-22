/**
 * The mail-sync worker's frozen wire fixtures: one recorded answer per outcome
 * of every function in `MAIL_SYNC_ENDPOINTS`, against one seeded deployment.
 *
 * The deployment: a password account (connected, two-way sync, aligned) whose
 * external mailbox maps INBOX and Archive and holds message 1 (INBOX, seen
 * there last) and message 2 (Archive); an OAuth account (pending, new mail
 * only); a Gmail seed mailbox with one settled and one expired probe; an
 * importing migration; and a queue of write-backs. apps/api's
 * `workerWireMailSync*.test.ts` seed exactly this and record each answer.
 */

import type { MAIL_SYNC_ENDPOINTS } from '../mailSync/index';
import type { LegacyWireFixtures, WireFixtures } from './types';
import { MAIL_SYNC_REMOTE_WIRE_FIXTURES } from './mailSyncRemote';
import { MAIL_SYNC_WIRE_IDS as M } from './mailSyncIds';

export { MAIL_SYNC_WIRE_IDS } from './mailSyncIds';

/** The password account's credentials, as the worker receives them. */
export const MAIL_SYNC_FIXTURE_CREDENTIALS = {
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'sync@example.com',
	smtpUsername: 'sync@example.com',
	imapPassword: 'imap-fixture-secret',
	smtpPassword: 'smtp-fixture-secret',
};

/** The OAuth account's: a live access token stands in for both passwords. */
export const MAIL_SYNC_FIXTURE_OAUTH_CREDENTIALS = {
	imapHost: 'imap.gmail.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.gmail.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'oauth@gmail.example',
	smtpUsername: 'oauth@gmail.example',
	imapPassword: '',
	smtpPassword: '',
	imapAccessToken: 'ya29.fixture-access',
	smtpAccessToken: 'ya29.fixture-access',
};

export const MAIL_SYNC_WIRE_FIXTURES = {
	getCredentialsForWorker: [
		{
			name: 'password account',
			value: { kind: 'credentials', credentials: MAIL_SYNC_FIXTURE_CREDENTIALS },
		},
		{
			name: 'oauth account',
			value: { kind: 'credentials', credentials: MAIL_SYNC_FIXTURE_OAUTH_CREDENTIALS },
		},
		{ name: 'missing', value: { kind: 'unavailable', reason: 'missing' } },
		{ name: 'disconnected', value: { kind: 'unavailable', reason: 'disconnected' } },
		{ name: 'grant revoked', value: { kind: 'unavailable', reason: 'auth_revoked' } },
		{ name: 'token refresh failed', value: { kind: 'unavailable', reason: 'refresh_failed' } },
	],
	listConnectableAccounts: [
		{
			name: 'pending and connected',
			value: [
				{
					accountId: M.oauthAccount,
					mailboxId: M.oauthMailbox,
					imapHost: 'imap.gmail.com',
					imapPort: 993,
					isImapSecure: true,
					imapUsername: 'oauth@gmail.example',
					status: 'pending',
				},
				{
					accountId: M.account,
					mailboxId: M.mailbox,
					imapHost: 'imap.example.com',
					imapPort: 993,
					isImapSecure: true,
					imapUsername: 'sync@example.com',
					status: 'connected',
				},
			],
		},
	],
	setSyncStatus: [{ name: 'written', value: null }],
	ingestExternalRaw: [
		{ name: 'stored', value: { messageId: M.ingested } },
		{ name: 'duplicate', value: { skipped: 'duplicate' } },
		{ name: 'no target', value: { skipped: 'no_target' } },
	],
	discardStagedRaw: [{ name: 'freed', value: null }],
	getSyncState: [
		{
			name: 'two folders',
			value: [
				{
					remoteName: 'INBOX',
					remoteUidValidity: 77,
					lastSeenUid: 120,
					folderId: M.inbox,
					forwardIngestFailures: [{ uid: 118, attempts: 1 }],
					forwardIngestFailureCount: 2,
				},
				{
					remoteName: 'Archive',
					remoteUidValidity: 78,
					lastSeenUid: 40,
					folderId: M.archive,
					forwardIngestFailures: [],
					forwardIngestFailureCount: 0,
				},
			],
		},
	],
	recordFolderMapping: [{ name: 'mapped', value: null }],
	recordForwardIngestFailure: [
		{ name: 'retry later', value: { retry: true, attempts: 2 } },
		{ name: 'unknown folder', value: { retry: false, attempts: 0 } },
	],
	listSeedProbeWork: [
		{
			name: 'one seed mailbox',
			value: {
				items: [
					{
						organizationId: 'org-fixture',
						accountId: M.seedAccount,
						address: 'seed@gmail.example',
						provider: 'gmail',
						probeIds: ['probe-settled'],
						expiredProbeIds: ['probe-expired'],
						clickHosts: ['convex.owlat.example', 'owlat.example'],
					},
				],
				cursor: null,
				isDone: true,
			},
		},
		{ name: 'nothing settled yet', value: { items: [], cursor: null, isDone: true } },
	],
	recordSeedProbeClassification: [
		{
			name: 'recorded',
			value: { recorded: true, placement: 'inbox', hygiene: { markRead: true, click: false } },
		},
		{ name: 'unknown probe', value: { recorded: false, reason: 'unknown_probe' } },
		{ name: 'not this organization', value: { recorded: false, reason: 'foreign_organization' } },
		{ name: 'never dispatched', value: { recorded: false, reason: 'never_dispatched' } },
		{ name: 'already classified', value: { recorded: false, reason: 'already_classified' } },
	],
	getBackfillWork: [
		{ name: 'importing', value: { isActive: true, migrationId: M.migration } },
		{
			name: 'paused for the provider budget',
			value: { isActive: true, migrationId: M.migration, resumesAt: 1_750_003_600_000 },
		},
		{ name: 'idle', value: { isActive: false, migrationId: null } },
	],
	initFolderBackfill: [
		{ name: 'started', value: { startCursor: 120 } },
		{ name: 'not importing', value: null },
	],
	findKnownMessageIds: [{ name: 'one known', value: ['<quarterly-1@example.com>'] }],
	recordBackfillProgress: [
		{ name: 'still importing', value: { stillImporting: true } },
		{ name: 'cancelled', value: { stillImporting: false } },
	],
	completeBackfillImport: [{ name: 'completed', value: null }],
	markImportFailed: [{ name: 'failed', value: null }],
	pauseImportForThrottle: [
		{ name: 'paused', value: { outcome: 'paused' } },
		{ name: 'given up', value: { outcome: 'failed' } },
		{ name: 'not importing', value: { outcome: 'ignored' } },
	],
	...MAIL_SYNC_REMOTE_WIRE_FIXTURES,
} satisfies WireFixtures<typeof MAIL_SYNC_ENDPOINTS>;

export const MAIL_SYNC_LEGACY_WIRE_FIXTURES = {
	getCredentialsForWorker: [
		{ name: 'pre-OAuth bundle', value: MAIL_SYNC_FIXTURE_CREDENTIALS },
		{ name: 'pre-OAuth miss', value: null },
	],
} satisfies LegacyWireFixtures<typeof MAIL_SYNC_ENDPOINTS>;
