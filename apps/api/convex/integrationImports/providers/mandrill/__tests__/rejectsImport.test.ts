/**
 * Mandrill rejection-blacklist carry-over (plan D9, P4.1).
 *
 * What has to hold, in the order it matters:
 *   1. **Reason routing** — the ten reasons Mandrill reports on one field mean
 *      very different things, and only some of them are statements about the
 *      MAILBOX. The reasons that describe OUR account (`invalid-sender`,
 *      `unsigned`, `test-mode-limit`, …) must import NOTHING: suppressing on
 *      them would let a misconfigured sending domain blocklist an entire
 *      audience in one import.
 *   2. **The key never leaks** — the credential travels in the request body,
 *      and any provider text that echoes it is redacted before it can reach
 *      `integrationImports.errors`, which the import UI renders.
 *   3. **Paging** — `rejects/list` has no cursor, so the adapter windows the
 *      response; a big blacklist must arrive as bounded batches.
 *   4. **Re-running is a no-op** — no second row, no second audit entry.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../../schema';
import { modules } from '../../../../__tests__/testModules';
import { enableFeatures } from '../../../../__tests__/factories';
import { internal } from '../../../../_generated/api';
import type { Doc, Id } from '../../../../_generated/dataModel';
import { mandrillProvider } from '../index';
import { RetryableProviderError } from '../../../_common';

vi.mock('../../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const API_KEY = 'md-secret-key-value';
const CONFIG = { provider: 'mandrill' as const };

type Entry = { email?: string; reason?: string; expired?: boolean };

function rejectsResponse(entries: Entry[]): Response {
	return new Response(JSON.stringify(entries), { status: 200 });
}

describe('mandrill rejects import — adapter', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.stubEnv('MANDRILL_API_KEY', API_KEY);
	});

	afterEach(() => {
		global.fetch = originalFetch;
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('refuses to start without a configured key, and says which one', () => {
		vi.stubEnv('MANDRILL_API_KEY', '');
		const result = mandrillProvider.validateConfig(CONFIG);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/MANDRILL_API_KEY/);
	});

	it('accepts the config when the key is present, and imports no contacts at all', () => {
		expect(mandrillProvider.validateConfig(CONFIG)).toEqual({ ok: true });
		// A rejection blacklist is a list of people to STOP mailing.
		expect(mandrillProvider.contactSource).toBeUndefined();
	});

	it('routes every reason Mandrill reports, and skips the ones that are about us', async () => {
		global.fetch = vi.fn().mockImplementation(() =>
			rejectsResponse([
				{ email: 'Hard@example.com', reason: 'hard-bounce' },
				{ email: 'soft@example.com', reason: 'soft-bounce' },
				{ email: 'spam@example.com', reason: 'spam' },
				{ email: 'unsub@example.com', reason: 'unsub' },
				{ email: 'custom@example.com', reason: 'custom' },
				{ email: 'rule@example.com', reason: 'rule' },
				// About OUR account / OUR message — never a suppression.
				{ email: 'sender@example.com', reason: 'invalid-sender' },
				{ email: 'invalid@example.com', reason: 'invalid' },
				{ email: 'testmode@example.com', reason: 'test-mode-limit' },
				{ email: 'unsigned@example.com', reason: 'unsigned' },
				{ email: 'future@example.com', reason: 'some-reason-mandrill-adds-later' },
				{ email: 'noreason@example.com' },
			])
		);

		const result = await mandrillProvider.fetchPage({ config: CONFIG, cursor: '' });

		expect(result.rows).toEqual([]);
		expect(result.suppressions).toEqual([
			{
				email: 'hard@example.com',
				reason: 'bounced',
				bounceType: 'hard',
				evidence: 'MANDRILL_REJECT_HARD_BOUNCE',
			},
			{
				email: 'soft@example.com',
				reason: 'bounced',
				bounceType: 'soft',
				evidence: 'MANDRILL_REJECT_SOFT_BOUNCE',
			},
			{ email: 'spam@example.com', reason: 'complained', evidence: 'MANDRILL_REJECT_SPAM' },
			{ email: 'unsub@example.com', reason: 'unsubscribe', evidence: 'MANDRILL_REJECT_UNSUB' },
			{ email: 'custom@example.com', reason: 'manual', evidence: 'MANDRILL_REJECT_CUSTOM' },
			{ email: 'rule@example.com', reason: 'manual', evidence: 'MANDRILL_REJECT_RULE' },
		]);
		expect(result.suppressionsSkipped).toBe(6);
	});

	it('skips entries with no address, and any entry already expired at Mandrill', async () => {
		global.fetch = vi
			.fn()
			.mockImplementation(() =>
				rejectsResponse([
					{ reason: 'hard-bounce' },
					{ email: 'lapsed@example.com', reason: 'hard-bounce', expired: true },
					{ email: 'live@example.com', reason: 'hard-bounce', expired: false },
				])
			);

		const result = await mandrillProvider.fetchPage({ config: CONFIG, cursor: '' });

		expect(result.suppressions?.map((s) => s.email)).toEqual(['live@example.com']);
		expect(result.suppressionsSkipped).toBe(2);
	});

	it('asks for non-expired entries only, with the key in the body and not the URL', async () => {
		const fetchSpy = vi.fn().mockImplementation(() => rejectsResponse([]));
		global.fetch = fetchSpy;

		await mandrillProvider.fetchPage({ config: CONFIG, cursor: '' });

		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe('https://mandrillapp.com/api/1.0/rejects/list');
		expect(url).not.toContain(API_KEY);
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			key: API_KEY,
			include_expired: false,
		});
	});

	it('scopes the import to MANDRILL_SUBACCOUNT when the deployment sets one', async () => {
		vi.stubEnv('MANDRILL_SUBACCOUNT', 'marketing');
		const fetchSpy = vi.fn().mockImplementation(() => rejectsResponse([]));
		global.fetch = fetchSpy;

		await mandrillProvider.fetchPage({ config: CONFIG, cursor: '' });

		expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
			subaccount: 'marketing',
		});
	});

	it('windows an unpaged response into bounded pages', async () => {
		const entries = Array.from({ length: 260 }, (_, i) => ({
			email: `u${i}@example.com`,
			reason: 'hard-bounce',
		}));
		global.fetch = vi.fn().mockImplementation(() => rejectsResponse(entries));

		const first = await mandrillProvider.fetchPage({ config: CONFIG, cursor: '' });
		expect(first.suppressions).toHaveLength(250);
		expect(first.suppressions?.[0]!.email).toBe('u0@example.com');
		expect(first.nextCursor).toBe('250');
		expect(first.totalEstimate).toBe(260);

		const second = await mandrillProvider.fetchPage({ config: CONFIG, cursor: '250' });
		expect(second.suppressions).toHaveLength(10);
		expect(second.suppressions?.[0]!.email).toBe('u250@example.com');
		expect(second.nextCursor).toBe(null);
	});

	it('treats an exactly-full final page as terminal', async () => {
		const entries = Array.from({ length: 250 }, (_, i) => ({
			email: `u${i}@example.com`,
			reason: 'spam',
		}));
		global.fetch = vi.fn().mockImplementation(() => rejectsResponse(entries));

		const page = await mandrillProvider.fetchPage({ config: CONFIG, cursor: '' });
		expect(page.suppressions).toHaveLength(250);
		expect(page.nextCursor).toBe(null);
	});

	it('retries a network blip and a 429, and fails an API error', async () => {
		global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.toBeInstanceOf(
			RetryableProviderError
		);

		global.fetch = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.toBeInstanceOf(
			RetryableProviderError
		);

		global.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ status: 'error', name: 'Invalid_Key', message: 'Invalid API key' }),
				{
					status: 500,
				}
			)
		);
		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.toThrow(
			'Invalid API key'
		);
	});

	it('never lets the key reach an error message, however the provider echoes it', async () => {
		// The exact leak this guards: a provider that echoes the request back
		// inside its error body. The message is surfaced into
		// `integrationImports.errors`, which the import UI renders.
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: `Bad request: {"key":"${API_KEY}"}` }), {
				status: 500,
			})
		);

		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.toThrow(
			/\[redacted\]/
		);
		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.not.toThrow(
			new RegExp(API_KEY)
		);

		global.fetch = vi.fn().mockRejectedValue(new Error(`connect failed for key ${API_KEY}`));
		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.toThrow(
			/\[redacted\]/
		);
	});

	it('rejects a response that is not a list, and one that is implausibly large', async () => {
		global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })));
		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.toThrow(
			/did not return a list/
		);

		const huge = Array.from({ length: 50_001 }, () => ({
			email: 'x@example.com',
			reason: 'spam',
		}));
		global.fetch = vi.fn().mockResolvedValue(rejectsResponse(huge));
		await expect(mandrillProvider.fetchPage({ config: CONFIG, cursor: '' })).rejects.toThrow(
			/refusing to import/
		);
	});
});

describe('mandrill rejects import — through the walker', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.stubEnv('MANDRILL_API_KEY', API_KEY);
	});

	afterEach(() => {
		global.fetch = originalFetch;
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	async function runImport(t: ReturnType<typeof convexTest>): Promise<Doc<'integrationImports'>> {
		const importId: Id<'integrationImports'> = await t.run(async (ctx) => {
			return await ctx.db.insert('integrationImports', {
				provider: 'mandrill',
				status: 'running',
				cursor: '',
				imported: 0,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
				handleDuplicates: 'skip',
				startedAt: Date.now(),
			});
		});
		await t.action(internal.integrationImports.walker.processIntegrationPage, {
			importId,
			config: CONFIG,
			cursor: '',
		});
		return (await t.run(async (ctx) => await ctx.db.get(importId))) as Doc<'integrationImports'>;
	}

	async function blocklist(t: ReturnType<typeof convexTest>) {
		return await t.run(async (ctx) => await ctx.db.query('blockedEmails').collect());
	}

	async function auditRows(t: ReturnType<typeof convexTest>) {
		return await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
	}

	const BLACKLIST: Entry[] = [
		{ email: 'hard@example.com', reason: 'hard-bounce' },
		{ email: 'soft@example.com', reason: 'soft-bounce' },
		{ email: 'spam@example.com', reason: 'spam' },
		{ email: 'custom@example.com', reason: 'custom' },
		{ email: 'unsub@example.com', reason: 'unsub' },
		{ email: 'sender@example.com', reason: 'invalid-sender' },
	];

	it('lands each reason on the blocklist with its own reason and Mandrill provenance', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mandrill']);
		global.fetch = vi.fn().mockImplementation(() => rejectsResponse(BLACKLIST));

		const record = await runImport(t);

		expect(record.status).toBe('completed');
		expect(record.imported).toBe(0);
		expect(record.suppressionCounts).toEqual({
			bouncedHard: 1,
			bouncedSoft: 1,
			complained: 1,
			manual: 1,
			alreadyBlocked: 0,
			unsubscribed: 0,
			alreadyUnsubscribed: 0,
			noContact: 1,
			skipped: 1,
		});

		const blocked = await blocklist(t);
		expect(
			Object.fromEntries(
				blocked.map((b) => [b.email, b.bounceType ? `${b.reason}/${b.bounceType}` : b.reason])
			)
		).toEqual({
			'hard@example.com': 'bounced/hard',
			'soft@example.com': 'bounced/soft',
			'spam@example.com': 'complained',
			'custom@example.com': 'manual',
		});

		const provenance = (await auditRows(t)).filter(
			(a) => a.action === 'blocklist.provider_suppressed'
		);
		expect(provenance).toHaveLength(4);
		expect(provenance.every((p) => p.details?.['provider'] === 'mandrill')).toBe(true);
		expect(provenance.every((p) => p.details?.['source'] === 'import')).toBe(true);
		expect(provenance.map((p) => p.details?.['evidence']).sort()).toEqual([
			'MANDRILL_REJECT_CUSTOM',
			'MANDRILL_REJECT_HARD_BOUNCE',
			'MANDRILL_REJECT_SOFT_BOUNCE',
			'MANDRILL_REJECT_SPAM',
		]);
	});

	it('writes one aggregated summary row for the run', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mandrill']);
		global.fetch = vi.fn().mockImplementation(() => rejectsResponse(BLACKLIST));

		await runImport(t);

		const summaries = (await auditRows(t)).filter(
			(a) => a.action === 'blocklist.provider_import_summary'
		);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.userId).toBe('system:mandrill_import');
		expect(summaries[0]!.details).toMatchObject({
			provider: 'mandrill',
			source: 'import',
			bouncedHard: 1,
			bouncedSoft: 1,
			complained: 1,
			manual: 1,
		});
	});

	it('re-running the import is a no-op — no new row, no new audit entry', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mandrill']);
		global.fetch = vi.fn().mockImplementation(() => rejectsResponse(BLACKLIST));

		await runImport(t);
		const blockedAfterFirst = await blocklist(t);
		const auditAfterFirst = await auditRows(t);

		const second = await runImport(t);

		expect(await blocklist(t)).toHaveLength(blockedAfterFirst.length);
		expect((await auditRows(t)).length).toBe(auditAfterFirst.length);
		expect(second.suppressionCounts).toMatchObject({
			bouncedHard: 0,
			bouncedSoft: 0,
			complained: 0,
			manual: 0,
			alreadyBlocked: 4,
		});
	});

	it('walks every page of a long blacklist to completion', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mandrill']);
		const entries = Array.from({ length: 260 }, (_, i) => ({
			email: `u${i}@example.com`,
			reason: 'hard-bounce',
		}));
		global.fetch = vi.fn().mockImplementation(() => rejectsResponse(entries));

		const t0 = await runImport(t);
		// The first hop schedules the next; drive the remaining hop the same way
		// the scheduler would.
		expect(t0.cursor).toBe('250');
		await t.action(internal.integrationImports.walker.processIntegrationPage, {
			importId: t0._id,
			config: CONFIG,
			cursor: '250',
		});

		const final = (await t.run(
			async (ctx) => await ctx.db.get(t0._id)
		)) as Doc<'integrationImports'>;
		expect(final.status).toBe('completed');
		expect(final.suppressionCounts?.bouncedHard).toBe(260);
		expect(await blocklist(t)).toHaveLength(260);

		// The first hop also SCHEDULED its successor. Drain it here rather than
		// letting it fire after the suite has restored `global.fetch` — a hop that
		// outlives its stub would reach the real network. It is a no-op: the run
		// is terminal, and every hop re-checks status at entry.
		await t.finishInProgressScheduledFunctions();
		expect(await blocklist(t)).toHaveLength(260);
	});

	it('never persists the API key in the run errors an operator can read', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mandrill']);
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: `rejected request key=${API_KEY}` }), {
				status: 500,
			})
		);

		const record = await runImport(t);

		expect(record.status).toBe('failed');
		expect(record.errors.join(' ')).not.toContain(API_KEY);
		expect(record.errors.join(' ')).toContain('[redacted]');
	});
});
