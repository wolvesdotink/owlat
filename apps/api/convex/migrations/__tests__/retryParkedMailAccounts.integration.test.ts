import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import type { Doc, Id } from '../../_generated/dataModel';

const MIGRATION = '0056_retry_parked_mail_accounts';
const migration = internal.migrations[MIGRATION];

type Harness = TestConvex<typeof schema>;
type AccountStatus = Doc<'externalMailAccounts'>['status'];

async function insertAccount(
	t: Harness,
	status: AccountStatus,
	options: { purpose?: 'seed'; index?: number } = {}
): Promise<Id<'externalMailAccounts'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const label = `${status}-${options.purpose ?? 'mail'}-${options.index ?? 0}`;
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-1',
			organizationId: 'org-1',
			address: `${label}@owlat.test`,
			domain: 'owlat.test',
			kind: 'external',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		return ctx.db.insert('externalMailAccounts', {
			userId: 'user-1',
			organizationId: 'org-1',
			mailboxId,
			...(options.purpose ? { purpose: options.purpose } : {}),
			imapHost: 'imap.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password',
			imapUsername: `${label}@owlat.test`,
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status,
			lastError: status === 'connected' ? undefined : 'Command failed',
			createdAt: now,
			updatedAt: now,
		});
	});
}

function status(t: Harness, id: Id<'externalMailAccounts'>): Promise<AccountStatus | undefined> {
	return t.run(async (ctx) => (await ctx.db.get(id))?.status);
}

function ledger(t: Harness): Promise<Doc<'migrationRuns'> | null> {
	return t.run((ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
			.unique()
	);
}

function drain(t: Harness): Promise<void> {
	return t.finishAllScheduledFunctions(vi.runAllTimers);
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('0056 retry parked mail accounts', () => {
	it('retries every parked mailbox across pages and records completion', async () => {
		const t = convexTest(schema, modules);
		const parked: Id<'externalMailAccounts'>[] = [];
		// More than one page (PAGE_SIZE is 50).
		for (let i = 0; i < 120; i++) parked.push(await insertAccount(t, 'auth_error', { index: i }));
		const seed = await insertAccount(t, 'auth_error', { purpose: 'seed' });
		const connected = await insertAccount(t, 'connected');

		expect(await t.mutation(migration.run, {})).toEqual({ started: true, generation: 1 });
		await drain(t);

		const statuses = await Promise.all(parked.map((id) => status(t, id)));
		expect(statuses.every((s) => s === 'pending')).toBe(true);
		const first = await t.run((ctx) => ctx.db.get(parked[0]!));
		expect(first?.lastError).toBeUndefined();
		expect(await status(t, seed)).toBe('auth_error');
		expect(await status(t, connected)).toBe('connected');

		expect(await ledger(t)).toMatchObject({
			status: 'completed',
			introducedIn: '0.6.7',
			changedCount: 120,
			scannedCount: 121,
		});
		expect((await ledger(t))!.pageCount).toBeGreaterThan(1);
	});

	it('leaves a mailbox parked again after completion alone until restarted', async () => {
		const t = convexTest(schema, modules);
		const account = await insertAccount(t, 'auth_error');
		await t.mutation(migration.run, {});
		await drain(t);
		expect(await status(t, account)).toBe('pending');

		// The worker found the credentials really are wrong and parked it again.
		await t.run((ctx) => ctx.db.patch(account, { status: 'auth_error' }));

		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
		await drain(t);
		expect(await status(t, account)).toBe('auth_error');

		expect(await t.mutation(migration.run, { restart: true })).toEqual({
			started: true,
			generation: 2,
		});
		await drain(t);
		expect(await status(t, account)).toBe('pending');
	});

	it('drops a page a later start superseded', async () => {
		const t = convexTest(schema, modules);
		const account = await insertAccount(t, 'auth_error');
		await t.mutation(migration.run, {});
		// Resume before the first page runs: generation 1 is now stale.
		await t.mutation(migration.run, {});

		const stale = await t.mutation(migration.retryPage, { cursor: null, generation: 1 });
		expect(stale).toMatchObject({ isSuperseded: true, retried: 0 });
		expect(await status(t, account)).toBe('auth_error');

		await drain(t);
		expect(await status(t, account)).toBe('pending');
		expect((await ledger(t))?.status).toBe('completed');
	});
});
