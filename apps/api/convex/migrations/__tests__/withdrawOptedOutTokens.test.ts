/**
 * Migration 0056 withdraws the confirmation token of every contact that opted
 * out before the token-withdrawal change and still holds a token issued at or
 * before that opt-out. A token issued after the opt-out (a later signup that
 * waits for a fresh confirmation) stays. Progress lives in the migration
 * ledger.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import { createTestContact } from '../../__tests__/factories';
import { DOI_TOKEN_TTL_MS, tokenPredatesOptOut } from '../../contacts/doiLifecycle';

type Harness = TestConvex<typeof schema>;

const MIGRATION = '0056_withdraw_opted_out_confirmation_tokens';
const migration = internal.migrations['0056_withdraw_opted_out_confirmation_tokens'];
const DAY = 24 * 60 * 60 * 1000;

function harness(): Harness {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

function ledger(t: Harness): Promise<Doc<'migrationRuns'> | null> {
	return t.run((ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
			.unique()
	);
}

async function insertContact(t: Harness, overrides: Record<string, unknown>) {
	return await t.run((ctx) => ctx.db.insert('contacts', createTestContact(overrides)));
}

async function getContact(t: Harness, id: Id<'contacts'>) {
	return await t.run((ctx) => ctx.db.get(id));
}

/** A pending contact holding a token issued at `issuedAt`, opted out at `optedOutAt`. */
function optedOutHoldingToken(token: string, issuedAt: number, optedOutAt: number) {
	return {
		doiStatus: 'pending',
		doiConfirmationToken: token,
		doiTokenExpiresAt: issuedAt + DOI_TOKEN_TTL_MS,
		unsubscribedAt: optedOutAt,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.UTC(2026, 9, 1));
});
afterEach(() => vi.useRealTimers());

describe('tokenPredatesOptOut', () => {
	const now = Date.UTC(2026, 9, 1);
	it.each([
		{ name: 'issued before the opt-out', issued: now - 2 * DAY, out: now - DAY, expected: true },
		{ name: 'issued at the opt-out', issued: now - DAY, out: now - DAY, expected: true },
		{ name: 'issued after the opt-out', issued: now - DAY, out: now - 2 * DAY, expected: false },
	])('$name → $expected', ({ issued, out, expected }) => {
		expect(
			tokenPredatesOptOut({
				doiConfirmationToken: 't',
				doiTokenExpiresAt: issued + DOI_TOKEN_TTL_MS,
				unsubscribedAt: out,
			})
		).toBe(expected);
	});

	it('a token without an expiry counts as issued before', () => {
		expect(
			tokenPredatesOptOut({
				doiConfirmationToken: 't',
				doiTokenExpiresAt: undefined,
				unsubscribedAt: now,
			})
		).toBe(true);
	});

	it('no opt-out or no token → false', () => {
		expect(
			tokenPredatesOptOut({
				doiConfirmationToken: 't',
				doiTokenExpiresAt: now,
				unsubscribedAt: undefined,
			})
		).toBe(false);
		expect(
			tokenPredatesOptOut({
				doiConfirmationToken: undefined,
				doiTokenExpiresAt: undefined,
				unsubscribedAt: now,
			})
		).toBe(false);
	});
});

describe('migration 0056', () => {
	it('withdraws pre-opt-out tokens across pages and keeps the rest', async () => {
		const t = harness();
		const now = Date.now();
		const stale: Id<'contacts'>[] = [];
		for (let i = 0; i < 250; i++) {
			stale.push(
				await insertContact(t, optedOutHoldingToken(`stale-${i}`, now - 2 * DAY, now - DAY))
			);
		}
		const noExpiry = await insertContact(t, {
			doiStatus: 'pending',
			doiConfirmationToken: 'no-expiry',
			unsubscribedAt: now - DAY,
		});
		const issuedAfter = await insertContact(
			t,
			optedOutHoldingToken('issued-after', now - DAY, now - 2 * DAY)
		);
		const neverOptedOut = await insertContact(t, {
			doiStatus: 'pending',
			doiConfirmationToken: 'still-subscribed',
			doiTokenExpiresAt: now + DAY,
		});

		expect(await t.mutation(migration.run, {})).toEqual({ started: true, generation: 1 });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		for (const id of [...stale, noExpiry]) {
			const contact = await getContact(t, id);
			expect(contact?.doiConfirmationToken).toBeUndefined();
			expect(contact?.doiTokenExpiresAt).toBeUndefined();
			expect(contact?.doiStatus).toBe('pending');
			expect(contact?.unsubscribedAt).toBeTypeOf('number');
		}
		expect((await getContact(t, issuedAfter))?.doiConfirmationToken).toBe('issued-after');
		expect((await getContact(t, neverOptedOut))?.doiConfirmationToken).toBe('still-subscribed');

		const done = await ledger(t);
		expect(done).toMatchObject({
			status: 'completed',
			introducedIn: '0.6.7',
			changedCount: 251,
		});
		expect(done!.pageCount).toBeGreaterThan(1);

		// Finished: a second run does nothing.
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});

	it('a withdrawn link can no longer lift the opt-out', async () => {
		const t = harness();
		const now = Date.now();
		const contactId = await insertContact(
			t,
			optedOutHoldingToken('pre-opt-out-link', now - DAY, now - 60_000)
		);

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(
			await t.mutation(api.forms.endpoints.confirmSubmission, { token: 'pre-opt-out-link' })
		).toEqual({ success: false, error: 'invalid_token' });
		const contact = await getContact(t, contactId);
		expect(contact?.unsubscribedAt).toBe(now - 60_000);
		expect(contact?.doiStatus).toBe('pending');
	});

	it('a stale chain from a superseded run does nothing', async () => {
		const t = harness();
		const now = Date.now();
		const contactId = await insertContact(
			t,
			optedOutHoldingToken('stale', now - 2 * DAY, now - DAY)
		);
		await t.mutation(migration.run, {});
		await t.mutation(migration.run, { restart: true });

		const stale = await t.mutation(migration.processPage, { cursor: null, generation: 1 });

		expect(stale).toMatchObject({ isSuperseded: true, withdrawn: 0 });
		expect((await getContact(t, contactId))?.doiConfirmationToken).toBe('stale');
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await getContact(t, contactId))?.doiConfirmationToken).toBeUndefined();
	});
});
