/**
 * How each mail-sync wire fixture is produced: the call the worker makes, against
 * the seeded deployment (`workerWireMailSync.testlib.ts`), for every fixture case
 * of the account, ingest, seed-probe and backfill endpoints. The write-back and
 * remote-sync endpoints are in `workerWireMailSyncRemoteDrives.testlib.ts`.
 */

import { MAIL_SYNC_WIRE_IDS as M, WIRE_FIXTURE_NOW } from '@owlat/worker-protocol/wireFixtures';
import { expect, vi } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { MAX_THROTTLE_PAUSES } from '../migrationBackfill';
import type { MailSyncWireWorld } from './workerWireMailSync.testlib';

export type MailSyncDrive = (w: MailSyncWireWorld) => Promise<unknown>;

/** Google's token endpoint answering once with `body`. */
function stubGoogleToken(body: Record<string, unknown>): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ status: 200, json: async () => body }) as unknown as Response)
	);
}

const credentials = (w: MailSyncWireWorld, accountId = w.accountId) =>
	w.t.action(internal.mail.external.accountsActions.getCredentialsForWorker, { accountId });

/** A raw message the ingest action can read the header block of. */
function rawMessage(messageId: string): { bytes: Buffer; base64: string } {
	const raw = [
		'From: Ada Lovelace <ada@example.com>',
		'To: sync@example.com',
		'Subject: Fresh news',
		`Message-ID: ${messageId}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Hello.',
		'',
	].join('\r\n');
	const bytes = Buffer.from(raw, 'utf-8');
	return { bytes, base64: bytes.toString('base64') };
}

async function ingest(w: MailSyncWireWorld, messageId: string, accountId = w.accountId) {
	const raw = rawMessage(messageId);
	const rawStorageId = await w.t.run((ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(raw.bytes)]))
	);
	return await w.t.action(internal.mail.external.delivery.ingestExternalRaw, {
		accountId,
		folderRole: 'inbox',
		remoteName: 'INBOX',
		remoteUid: 121,
		remoteUidValidity: 77,
		rawStorageId,
		rawSize: raw.bytes.byteLength,
		headerBlockBase64: raw.base64,
		from: 'Ada Lovelace <ada@example.com>',
		to: ['sync@example.com'],
		cc: [],
		bcc: [],
		subject: 'Fresh news',
		textBodyInline: 'Hello.',
		messageId,
		receivedAt: WIRE_FIXTURE_NOW,
		attachments: [],
		flagSeen: false,
		origin: 'backfill',
	});
}

const setMigration = (
	w: MailSyncWireWorld,
	patch: { status?: 'cancelled'; resumesAt?: number; throttlePauses?: number }
) => w.t.run((ctx) => ctx.db.patch(w.migrationId, patch));

const pause = (w: MailSyncWireWorld) =>
	w.t.mutation(internal.mail.migrationBackfill.pauseImportForThrottle, {
		migrationId: w.migrationId,
		resumeAt: WIRE_FIXTURE_NOW + 60 * 60 * 1000,
		reason: 'Account exceeded command or bandwidth limits.',
	});

const classify = (w: MailSyncWireWorld, probeId: string) =>
	w.t.mutation(internal.analytics.seedPlacement.recordSeedProbeClassification, {
		organizationId: 'org-fixture',
		probeId,
		folderName: 'INBOX',
		now: WIRE_FIXTURE_NOW,
		clickRoll: 0.99,
	});

export const MAIL_SYNC_DRIVES = {
	getCredentialsForWorker: {
		'password account': (w) => credentials(w),
		'oauth account': (w) => {
			stubGoogleToken({ access_token: 'ya29.fixture-access', expires_in: 3599 });
			return credentials(w, w.oauthAccountId);
		},
		missing: (w) => credentials(w, w.goneAccountId),
		disconnected: async (w) => {
			await w.t.run((ctx) => ctx.db.patch(w.accountId, { status: 'disconnected' }));
			return await credentials(w);
		},
		'grant revoked': (w) => {
			stubGoogleToken({ error: 'invalid_grant' });
			return credentials(w, w.oauthAccountId);
		},
		'token refresh failed': (w) => {
			stubGoogleToken({ error: 'temporarily_unavailable' });
			return credentials(w, w.oauthAccountId);
		},
	},
	listConnectableAccounts: {
		'pending and connected': (w) =>
			w.t.query(internal.mail.external.accounts.listConnectableAccounts, {}),
	},
	setSyncStatus: {
		written: (w) =>
			w.t.mutation(internal.mail.external.accounts.setSyncStatus, {
				accountId: w.accountId,
				status: 'error',
				lastError: 'Connection reset',
				markSynced: false,
			}),
	},
	ingestExternalRaw: {
		stored: async (w) => {
			const outcome = await ingest(w, '<fresh-4@example.com>');
			expect(outcome).toHaveProperty('messageId');
			const messageId = (outcome as { messageId: Id<'mailMessages'> }).messageId;
			const row = await w.t.run((ctx) => ctx.db.get(messageId));
			expect(row).toMatchObject({ rfc822MessageId: 'fresh-4@example.com' });
			w.ids[M.ingested] = messageId;
			return outcome;
		},
		duplicate: (w) => ingest(w, '<quarterly-1@example.com>'),
		'no target': (w) => ingest(w, '<fresh-5@example.com>', w.goneAccountId),
	},
	discardStagedRaw: {
		freed: async (w) => {
			const rawStorageId = await w.t.run((ctx) => ctx.storage.store(new Blob(['staged'])));
			return await w.t.mutation(internal.mail.external.delivery.discardStagedRaw, {
				rawStorageId,
			});
		},
	},
	getSyncState: {
		'two folders': (w) =>
			w.t.query(internal.mail.external.delivery.getSyncState, { accountId: w.accountId }),
	},
	recordFolderMapping: {
		mapped: (w) =>
			w.t.mutation(internal.mail.external.delivery.recordFolderMapping, {
				accountId: w.accountId,
				folderRole: 'sent',
				remoteName: 'Sent',
				remoteUidValidity: 79,
				initialLastSeenUid: 5,
			}),
	},
	recordForwardIngestFailure: {
		'retry later': (w) =>
			w.t.mutation(internal.mail.external.delivery.recordForwardIngestFailure, {
				accountId: w.accountId,
				remoteName: 'INBOX',
				remoteUidValidity: 77,
				uid: 118,
			}),
		'unknown folder': (w) =>
			w.t.mutation(internal.mail.external.delivery.recordForwardIngestFailure, {
				accountId: w.accountId,
				remoteName: 'Newsletters',
				remoteUidValidity: 80,
				uid: 3,
			}),
	},
	listSeedProbeWork: {
		'one seed mailbox': (w) =>
			w.t.query(internal.analytics.seedProbePoller.listSeedProbeWork, {
				now: WIRE_FIXTURE_NOW,
				cursor: null,
			}),
		// Before either probe has settled: the expired one was dispatched ten
		// minutes earlier, the other not at all yet.
		'nothing settled yet': (w) =>
			w.t.query(internal.analytics.seedProbePoller.listSeedProbeWork, {
				now: WIRE_FIXTURE_NOW - (24 * 60 + 50) * 60 * 1000,
			}),
	},
	recordSeedProbeClassification: {
		recorded: (w) => classify(w, 'probe-settled'),
		'unknown probe': (w) => classify(w, 'probe-unknown'),
		'already classified': async (w) => {
			await classify(w, 'probe-settled');
			return await classify(w, 'probe-settled');
		},
	},
	getBackfillWork: {
		importing: (w) =>
			w.t.query(internal.mail.migrationBackfill.getBackfillWork, { accountId: w.accountId }),
		'paused for the provider budget': async (w) => {
			await setMigration(w, { resumesAt: WIRE_FIXTURE_NOW + 60 * 60 * 1000 });
			return await w.t.query(internal.mail.migrationBackfill.getBackfillWork, {
				accountId: w.accountId,
			});
		},
		idle: (w) =>
			w.t.query(internal.mail.migrationBackfill.getBackfillWork, {
				accountId: w.oauthAccountId,
			}),
	},
	initFolderBackfill: {
		started: (w) => initFolder(w),
		'not importing': async (w) => {
			await setMigration(w, { status: 'cancelled' });
			return await initFolder(w);
		},
	},
	findKnownMessageIds: {
		'one known': (w) =>
			w.t.query(internal.mail.migrationBackfill.findKnownMessageIds, {
				accountId: w.accountId,
				messageIds: ['<quarterly-1@example.com>', '<unknown@example.com>'],
			}),
	},
	recordBackfillProgress: {
		'still importing': (w) => progress(w),
		cancelled: async (w) => {
			await setMigration(w, { status: 'cancelled' });
			return await progress(w);
		},
	},
	completeBackfillImport: {
		completed: (w) =>
			w.t.mutation(internal.mail.migrationBackfill.completeBackfillImport, {
				migrationId: w.migrationId,
			}),
	},
	markImportFailed: {
		failed: (w) =>
			w.t.mutation(internal.mail.migrationBackfill.markImportFailed, {
				migrationId: w.migrationId,
				errorMessage: 'IMAP connection closed',
			}),
	},
	pauseImportForThrottle: {
		paused: (w) => pause(w),
		'given up': async (w) => {
			await setMigration(w, { throttlePauses: MAX_THROTTLE_PAUSES });
			return await pause(w);
		},
		'not importing': async (w) => {
			await setMigration(w, { status: 'cancelled' });
			return await pause(w);
		},
	},
} satisfies Record<string, Record<string, MailSyncDrive>>;

function initFolder(w: MailSyncWireWorld) {
	return w.t.mutation(internal.mail.migrationBackfill.initFolderBackfill, {
		accountId: w.accountId,
		migrationId: w.migrationId,
		remoteName: 'INBOX',
		ceilingUid: 120,
		messageCount: 2,
	});
}

function progress(w: MailSyncWireWorld) {
	return w.t.mutation(internal.mail.migrationBackfill.recordBackfillProgress, {
		accountId: w.accountId,
		migrationId: w.migrationId,
		remoteName: 'INBOX',
		newCursor: 60,
		importedDelta: 2,
		failedDelta: 0,
	});
}
