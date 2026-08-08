/**
 * Mailchimp suppression carry-over (plan D9, P4.1) — adapter routing + the
 * end-to-end walk that turns it into state.
 *
 * The thing under test is a migration promise: a team that unsubscribed 4,000
 * people at Mailchimp must not be able to mail any of them from Owlat on day
 * one, and running the carry-over twice must be indistinguishable from running
 * it once.
 *
 * Two layers, both with `global.fetch` stubbed:
 *   - adapter: status → disposition, no extra request, paging, and the opt-in
 *     gate (`importSuppressions` absent ⇒ byte-identical to the pre-P4.1
 *     contacts import).
 *   - walker: `unsubscribed` reaches the CONSENT path and `cleaned` reaches the
 *     blocklist with `source: 'import'` provenance; the re-run writes no row and
 *     no audit entry; the run summary is one aggregated row; contacts are
 *     imported exactly as before alongside it.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../../schema';
import { modules } from '../../../../__tests__/testModules';
import { enableFeatures } from '../../../../__tests__/factories';
import { internal } from '../../../../_generated/api';
import type { Doc, Id } from '../../../../_generated/dataModel';
import { mailchimpProvider } from '../index';

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

const CONFIG = {
	provider: 'mailchimp' as const,
	apiKey: 'abc123-us21',
	listId: 'list_a',
	importSuppressions: true,
};

type Member = { email: string; status: string };

function membersResponse(members: Member[], totalItems = members.length): Response {
	return new Response(
		JSON.stringify({
			members: members.map((m) => ({
				email_address: m.email,
				status: m.status,
				merge_fields: { FNAME: 'F', LNAME: 'L' },
			})),
			total_items: totalItems,
		}),
		{ status: 200 }
	);
}

describe('mailchimp suppression carry-over — adapter', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('routes unsubscribed to the consent path and cleaned to a hard bounce', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			membersResponse([
				{ email: 'Sub@example.com', status: 'subscribed' },
				{ email: 'Gone@example.com', status: 'unsubscribed' },
				{ email: 'Dead@example.com', status: 'cleaned' },
			])
		);

		const result = await mailchimpProvider.fetchPage({ config: CONFIG, cursor: '' });

		expect(result.rows.map((r) => r.email)).toEqual(['sub@example.com']);
		expect(result.suppressions).toEqual([
			{ email: 'gone@example.com', reason: 'unsubscribe', evidence: 'unsubscribed' },
			{
				email: 'dead@example.com',
				reason: 'bounced',
				bounceType: 'hard',
				evidence: 'cleaned',
			},
		]);
		expect(result.suppressionsSkipped).toBeUndefined();
	});

	it('counts pending/transactional/archived members as skipped, never as suppressions', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			membersResponse([
				{ email: 'pending@example.com', status: 'pending' },
				{ email: 'tx@example.com', status: 'transactional' },
				{ email: 'archived@example.com', status: 'archived' },
				{ email: 'future@example.com', status: 'some_status_mailchimp_adds_later' },
			])
		);

		const result = await mailchimpProvider.fetchPage({ config: CONFIG, cursor: '' });

		expect(result.suppressions).toBeUndefined();
		expect(result.suppressionsSkipped).toBe(4);
		expect(result.rows).toEqual([]);
	});

	it('carries suppressions on every page of a paged audience, with no extra request', async () => {
		const page = Array.from({ length: 100 }, (_, i) => ({
			email: `u${i}@example.com`,
			status: i % 2 === 0 ? 'subscribed' : 'unsubscribed',
		}));
		const fetchSpy = vi.fn().mockImplementation(() => membersResponse(page, 250));
		global.fetch = fetchSpy;

		const first = await mailchimpProvider.fetchPage({ config: CONFIG, cursor: '' });
		expect(first.nextCursor).toBe('100');
		expect(first.rows).toHaveLength(50);
		expect(first.suppressions).toHaveLength(50);

		const second = await mailchimpProvider.fetchPage({ config: CONFIG, cursor: '100' });
		expect(second.suppressions).toHaveLength(50);

		// One request per page — the suppressions ride the SAME response the
		// contacts do. A second status-filtered fetch would show up here.
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]![0]).toContain('offset=0');
		expect(fetchSpy.mock.calls[1]![0]).toContain('offset=100');
	});

	it('carries nothing when the toggle is off (pre-P4.1 behavior, unchanged)', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			membersResponse([
				{ email: 'sub@example.com', status: 'subscribed' },
				{ email: 'gone@example.com', status: 'unsubscribed' },
				{ email: 'dead@example.com', status: 'cleaned' },
			])
		);

		const result = await mailchimpProvider.fetchPage({
			config: { provider: 'mailchimp', apiKey: CONFIG.apiKey, listId: CONFIG.listId },
			cursor: '',
		});

		expect(result.suppressions).toBeUndefined();
		expect(result.suppressionsSkipped).toBeUndefined();
		expect(result.rows.map((r) => r.email)).toEqual(['sub@example.com']);
	});
});

describe('mailchimp suppression carry-over — through the walker', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	async function seedRun(t: ReturnType<typeof convexTest>): Promise<Id<'integrationImports'>> {
		return await t.run(async (ctx) => {
			return await ctx.db.insert('integrationImports', {
				provider: 'mailchimp',
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
	}

	async function runImport(t: ReturnType<typeof convexTest>): Promise<Doc<'integrationImports'>> {
		const importId = await seedRun(t);
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

	it('suppresses cleaned addresses, unsubscribes departures, and imports contacts', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'gone@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		global.fetch = vi.fn().mockImplementation(() =>
			membersResponse([
				{ email: 'keep@example.com', status: 'subscribed' },
				{ email: 'gone@example.com', status: 'unsubscribed' },
				{ email: 'dead@example.com', status: 'cleaned' },
				{ email: 'pending@example.com', status: 'pending' },
			])
		);

		const record = await runImport(t);

		expect(record.status).toBe('completed');
		expect(record.imported).toBe(1);
		expect(record.suppressionCounts).toEqual({
			bouncedHard: 1,
			bouncedSoft: 0,
			complained: 0,
			manual: 0,
			alreadyBlocked: 0,
			unsubscribed: 1,
			alreadyUnsubscribed: 0,
			noContact: 0,
			skipped: 1,
		});

		// The cleaned address is blocked, and reads as carried over from Mailchimp.
		const blocked = await blocklist(t);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]!.email).toBe('dead@example.com');
		expect(blocked[0]!.reason).toBe('bounced');
		expect(blocked[0]!.bounceType).toBe('hard');

		const provenance = (await auditRows(t)).filter(
			(a) => a.action === 'blocklist.provider_suppressed'
		);
		expect(provenance).toHaveLength(1);
		expect(provenance[0]!.details).toMatchObject({
			provider: 'mailchimp',
			source: 'import',
			evidence: 'cleaned',
		});

		// The departure went through the CONSENT path, not the blocklist.
		const gone = await t.run(
			async (ctx) =>
				await ctx.db
					.query('contacts')
					.withIndex('by_email', (q) => q.eq('email', 'gone@example.com'))
					.first()
		);
		expect(gone?.unsubscribedAt).toBeGreaterThan(0);
		expect(blocked.some((b) => b.email === 'gone@example.com')).toBe(false);

		// And the contacts import is untouched by any of it.
		const keep = await t.run(
			async (ctx) =>
				await ctx.db
					.query('contacts')
					.withIndex('by_email', (q) => q.eq('email', 'keep@example.com'))
					.first()
		);
		expect(keep).not.toBeNull();
	});

	it('writes one aggregated summary entry per run that changed something', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		global.fetch = vi
			.fn()
			.mockImplementation(() =>
				membersResponse([{ email: 'dead@example.com', status: 'cleaned' }])
			);

		await runImport(t);

		const summaries = (await auditRows(t)).filter(
			(a) => a.action === 'blocklist.provider_import_summary'
		);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.resource).toBe('blocklist');
		expect(summaries[0]!.userId).toBe('system:mailchimp_import');
		expect(summaries[0]!.details).toMatchObject({
			provider: 'mailchimp',
			source: 'import',
			bouncedHard: 1,
			unsubscribed: 0,
		});
	});

	it('re-running the carry-over is a no-op — no row, no audit entry, no second unsubscribe', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'gone@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		global.fetch = vi.fn().mockImplementation(() =>
			membersResponse([
				{ email: 'gone@example.com', status: 'unsubscribed' },
				{ email: 'dead@example.com', status: 'cleaned' },
			])
		);

		await runImport(t);
		const blockedAfterFirst = await blocklist(t);
		const auditAfterFirst = await auditRows(t);

		const second = await runImport(t);

		expect(await blocklist(t)).toHaveLength(blockedAfterFirst.length);
		expect((await auditRows(t)).length).toBe(auditAfterFirst.length);
		expect(second.suppressionCounts).toEqual({
			bouncedHard: 0,
			bouncedSoft: 0,
			complained: 0,
			manual: 0,
			alreadyBlocked: 1,
			unsubscribed: 0,
			alreadyUnsubscribed: 1,
			noContact: 0,
			skipped: 0,
		});
	});

	it('reports an unsubscribe for an address that is not a contact as noContact', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		global.fetch = vi
			.fn()
			.mockImplementation(() =>
				membersResponse([{ email: 'stranger@example.com', status: 'unsubscribed' }])
			);

		const record = await runImport(t);

		expect(record.suppressionCounts?.noContact).toBe(1);
		expect(await blocklist(t)).toHaveLength(0);
		// Nothing changed, so no summary row either.
		expect(
			(await auditRows(t)).filter((a) => a.action === 'blocklist.provider_import_summary')
		).toHaveLength(0);
	});

	it('leaves the contacts-only import exactly as it was when the toggle is off', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		global.fetch = vi.fn().mockImplementation(() =>
			membersResponse([
				{ email: 'keep@example.com', status: 'subscribed' },
				{ email: 'dead@example.com', status: 'cleaned' },
			])
		);

		const importId = await seedRun(t);
		await t.action(internal.integrationImports.walker.processIntegrationPage, {
			importId,
			config: { provider: 'mailchimp', apiKey: CONFIG.apiKey, listId: CONFIG.listId },
			cursor: '',
		});
		const record = (await t.run(
			async (ctx) => await ctx.db.get(importId)
		)) as Doc<'integrationImports'>;

		expect(record.imported).toBe(1);
		expect(record.suppressionCounts).toBeUndefined();
		expect(await blocklist(t)).toHaveLength(0);
	});
});
