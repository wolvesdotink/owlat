/**
 * The worker half of the throttle pause: when a provider keeps answering "over
 * quota" until the throttled ladder is spent, `maybeRunBackfill` records a
 * pause on the migration — it no longer fails it — and it honours a pause the
 * migration already carries, so a restarted worker does not hammer an account
 * whose budget is still spent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectableAccount, ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';
import { MAX_BACKFILL_STRIKES, THROTTLE_PAUSE_MS } from '../backfillRetry.js';

vi.mock('../ingest.js', () => ({
	ingestMessage: vi.fn(async () => ({ messageId: 'msg_1' })),
	isMessageLanded: vi.fn(() => true),
}));

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: log }));

const backfill = vi.hoisted(() => ({ backfillFolder: vi.fn(async () => {}) }));
vi.mock('../backfill.js', () => ({ backfillFolder: backfill.backfillFolder }));

const { AccountConnection } = await import('../connection.js');

const ACCOUNT: ConnectableAccount = {
	accountId: 'acct_1',
	mailboxId: 'mbx_1',
	imapHost: 'imap.gmail.example',
	imapPort: 993,
	isImapSecure: true,
	imapUsername: 'team@owlat.test',
	status: 'connected',
};

const CONFIG = { backfillBatchSize: 50 } as unknown as MailSyncConfig;

const START = Date.UTC(2026, 8, 24, 8, 0);

type Internals = {
	client: unknown;
	folders: Array<{ remoteName: string; role: string }>;
	readFolderMeta(): Promise<{ ceilingUid: number; messageCount: number; uidValidity: number }>;
	pollInboxForward(): Promise<void>;
	resumeInboxIdle(): Promise<void>;
	maybeRunBackfill(): Promise<void>;
};

/** Gmail's shape: ImapFlow's NoConnection error carrying the server's BYE. */
function overQuota(): Error {
	return Object.assign(new Error('Connection not available'), {
		code: 'NoConnection',
		reason: 'Account exceeded command or bandwidth limits.',
	});
}

function connection(
	work: Record<string, unknown>,
	pauseOutcome: 'paused' | 'failed' | 'ignored' = 'paused'
) {
	const mutation = vi.fn(async (ref: string) =>
		ref.includes('pauseImportForThrottle') ? { outcome: pauseOutcome } : {}
	);
	const convex = {
		query: vi.fn(async (ref: string) => (ref.includes('getBackfillWork') ? work : ([] as unknown))),
		mutation,
		action: vi.fn(async () => ({})),
	} as unknown as ConvexClient;
	const conn = new AccountConnection(ACCOUNT, convex, CONFIG) as unknown as Internals;
	conn.client = {};
	conn.folders = [{ remoteName: '[Gmail]/Sent Mail', role: 'sent' }];
	conn.readFolderMeta = async () => ({ ceilingUid: 900, messageCount: 500, uidValidity: 7 });
	conn.pollInboxForward = async () => {};
	conn.resumeInboxIdle = async () => {};
	return { conn, mutation };
}

function calls(mutation: ReturnType<typeof vi.fn>, name: string) {
	return mutation.mock.calls.filter(([ref]) => String(ref).includes(name));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	backfill.backfillFolder.mockReset();
	log.warn.mockClear();
	log.info.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a throttled import that spends its retry ladder', () => {
	it('pauses the migration for a full window instead of failing it', async () => {
		backfill.backfillFolder.mockRejectedValue(overQuota());
		const { conn, mutation } = connection({ isActive: true, migrationId: 'mig_1' });

		// Every retry the ladder allows, each one as soon as it is allowed.
		for (let i = 0; i < MAX_BACKFILL_STRIKES; i++) {
			await conn.maybeRunBackfill();
			await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
		}

		expect(backfill.backfillFolder).toHaveBeenCalledTimes(MAX_BACKFILL_STRIKES);
		expect(calls(mutation, 'markImportFailed')).toHaveLength(0);
		const pauses = calls(mutation, 'pauseImportForThrottle');
		expect(pauses).toHaveLength(1);
		const args = pauses[0]![1] as { migrationId: string; resumeAt: number; reason: string };
		expect(args.migrationId).toBe('mig_1');
		// Measured from the first throttled run — when the budget actually ran out.
		expect(args.resumeAt).toBe(START + THROTTLE_PAUSE_MS);
		expect(args.reason).toContain('exceeded command or bandwidth limits');
	});

	it('does not run again before the pause is over', async () => {
		backfill.backfillFolder.mockRejectedValue(overQuota());
		const { conn } = connection({ isActive: true, migrationId: 'mig_1' });
		for (let i = 0; i < MAX_BACKFILL_STRIKES; i++) {
			await conn.maybeRunBackfill();
			await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
		}
		backfill.backfillFolder.mockClear();

		vi.setSystemTime(START + THROTTLE_PAUSE_MS - 60_000);
		await conn.maybeRunBackfill();
		expect(backfill.backfillFolder).not.toHaveBeenCalled();

		vi.setSystemTime(START + THROTTLE_PAUSE_MS);
		await conn.maybeRunBackfill();
		expect(backfill.backfillFolder).toHaveBeenCalledTimes(1);
	});

	it('logs a pause only when the server actually recorded one', async () => {
		async function runLadder(outcome: 'paused' | 'failed' | 'ignored') {
			log.warn.mockClear();
			log.info.mockClear();
			backfill.backfillFolder.mockRejectedValue(overQuota());
			const { conn } = connection({ isActive: true, migrationId: 'mig_1' }, outcome);
			for (let i = 0; i < MAX_BACKFILL_STRIKES; i++) {
				await conn.maybeRunBackfill();
				await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
			}
			return [...log.warn.mock.calls, ...log.info.mock.calls].map(([, msg]) => msg);
		}

		expect(await runLadder('paused')).toContain(
			'provider budget spent; backfill paused until it resets'
		);

		const failed = await runLadder('failed');
		expect(failed).toContain('throttle pause cap reached; migration failed');
		expect(failed).not.toContain('provider budget spent; backfill paused until it resets');

		const ignored = await runLadder('ignored');
		expect(ignored).toContain('throttle pause ignored; migration no longer importing');
		expect(ignored).not.toContain('provider budget spent; backfill paused until it resets');
	});

	it('still fails an import whose failures are not the provider throttling it', async () => {
		backfill.backfillFolder.mockRejectedValue(new Error('Invalid messageset'));
		const { conn, mutation } = connection({ isActive: true, migrationId: 'mig_1' });

		for (let i = 0; i < MAX_BACKFILL_STRIKES; i++) {
			await conn.maybeRunBackfill();
			await vi.advanceTimersByTimeAsync(30 * 60_000);
		}

		expect(calls(mutation, 'pauseImportForThrottle')).toHaveLength(0);
		expect(calls(mutation, 'markImportFailed')).toHaveLength(1);
	});
});

describe('a pause recorded on the migration', () => {
	it('holds a freshly started worker until it is over', async () => {
		const { conn } = connection({
			isActive: true,
			migrationId: 'mig_1',
			resumesAt: START + 6 * 60 * 60_000,
		});

		await conn.maybeRunBackfill();
		expect(backfill.backfillFolder).not.toHaveBeenCalled();

		vi.setSystemTime(START + 6 * 60 * 60_000);
		await conn.maybeRunBackfill();
		expect(backfill.backfillFolder).toHaveBeenCalledTimes(1);
	});
});
