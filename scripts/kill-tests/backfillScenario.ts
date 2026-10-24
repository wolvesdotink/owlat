/**
 * SIGKILL the mail-sync worker mid-backfill and check the import still lands
 * every message exactly once.
 *
 * The owner connects the fixture mailbox and starts an import through the
 * backend's own functions (backend.ts). The IMAP fixture holds ten messages;
 * the worker walks them newest first in batches of four (compose.yml
 * MAIL_SYNC_BACKFILL_BATCH). The kill lands in the second batch, on UID 6: the
 * backend has stored it and the world never passes the answer on, so the
 * worker dies with that batch's cursor unadvanced and the message already
 * stored. UID 6 has no Message-ID, so after the restart only the worker's
 * synthetic identity keeps the re-walk from storing it twice.
 */

import {
	backfillSubject,
	checkBackfillRun,
	type BackfillState,
	type IngestCallState,
} from './oracle';
import type { KillStack } from './stack';

const IMAP_USER = 'migrate@owlat.test';
/** The stock dovecot image accepts any user with this password. */
const IMAP_PASSWORD = 'pass';
const UIDS = Array.from({ length: 10 }, (_, index) => index + 1);
const HELD_UID = 6;
const BUDGET_MS = 120_000;

function fixtureMessage(uid: number): string {
	const headers = [
		'From: Sender <sender@owlat.example>',
		`To: ${IMAP_USER}`,
		`Subject: ${backfillSubject(uid)}`,
		`Date: Fri, 23 Oct 2026 10:00:${String(uid).padStart(2, '0')} +0000`,
		...(uid === HELD_UID ? [] : [`Message-ID: <kill-backfill-${uid}@owlat.example>`]),
	];
	return `${headers.join('\r\n')}\r\n\r\nbody ${uid}\r\n`;
}

export async function runBackfillScenario(
	stack: KillStack,
	log: (line: string) => void
): Promise<string[]> {
	// Delivered in UID order: `doveadm save` appends, so message n gets UID n.
	for (const uid of UIDS) {
		stack.compose(['exec', '-T', 'imap', 'doveadm', 'save', '-u', IMAP_USER], {
			input: fixtureMessage(uid),
		});
	}
	// The import exists before the worker boots, so its first connect starts it.
	const backend = stack.backend();
	const account = await backend.connectAndImport(await backend.signInOwner(), {
		emailAddress: IMAP_USER,
		host: 'imap.owlat.test',
		port: 143,
		password: IMAP_PASSWORD,
	});
	await stack.holdIngest([HELD_UID]);
	stack.compose(['up', '-d', '--no-build', 'mail-sync']);
	log('mail-sync started; waiting for the backfill to reach the pinned message');

	await stack.waitFor(`convex.ingest.held:${HELD_UID}`, BUDGET_MS);
	stack.kill('mail-sync');
	stack.restart('mail-sync');
	log(`killed mail-sync with UID ${HELD_UID} stored but unanswered; restarted`);

	await stack.waitFor('convex.backfill.complete', BUDGET_MS);
	const { ingestCalls } = await stack.state<{ ingestCalls: IngestCallState[] }>();
	const ofAccount = (table: string, key: string, id: string) =>
		backend.rows(table).filter((row) => row[key] === id);
	const state = {
		messages: ofAccount('mailMessages', 'mailboxId', account.mailboxId),
		ingestCalls,
		migration: ofAccount('mailboxMigrations', 'accountId', account.accountId)[0] ?? null,
		inbox:
			ofAccount('externalMailFolderSync', 'accountId', account.accountId).find(
				(row) => row['remoteName'] === 'INBOX'
			) ?? null,
	} as unknown as BackfillState;
	return checkBackfillRun(UIDS, HELD_UID, state);
}
