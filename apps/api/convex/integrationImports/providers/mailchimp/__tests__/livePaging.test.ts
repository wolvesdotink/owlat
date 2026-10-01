/**
 * Mailchimp paging against an audience that changes during the run (#1075).
 *
 * Pages are separate requests, minutes apart when one is retried, and the
 * audience keeps receiving signups, unsubscribes and deletions in between.
 * Plain offset paging skipped the member that a deletion on an earlier page
 * moved back across the boundary, and never saw a change to a member it had
 * already read. The fake audience applies the change right before the named
 * request is answered.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../../schema';
import { modules } from '../../../../__tests__/testModules';
import { enableFeatures } from '../../../../__tests__/factories';
import { api } from '../../../../_generated/api';
import type { Doc } from '../../../../_generated/dataModel';
import type { SuppressionRow } from '../../../_common';
import { fakeMailchimpAudience, type FakeAudience } from '../../../__tests__/fakeMailchimpAudience';
import { mailchimpProvider, PAGE_OVERLAP } from '../index';

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

/** 250 subscribers, `u0` … `u249`: three audience pages. */
function audienceOf(size = 250): FakeAudience {
	return fakeMailchimpAudience(
		Array.from({ length: size }, (_, i) => ({ email: `u${i}@example.com`, status: 'subscribed' }))
	);
}

function subscribedEmails(audience: FakeAudience): string[] {
	return audience.members.filter((m) => m.status === 'subscribed').map((m) => m.email);
}

/** Every page the adapter walks, from the first-page cursor to the end. */
async function walk(audience: FakeAudience) {
	global.fetch = audience.fetch;
	const emails: string[] = [];
	const suppressions: SuppressionRow[] = [];
	const totals: (number | undefined)[] = [];
	let cursor: string | null = '';
	while (cursor !== null) {
		const page = await mailchimpProvider.fetchPage({ config: CONFIG, cursor });
		emails.push(...page.rows.map((row) => row.email));
		suppressions.push(...(page.suppressions ?? []));
		totals.push(page.totalEstimate);
		cursor = page.nextCursor;
	}
	return { emails, suppressions, totals };
}

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('mailchimp paging — adapter', () => {
	it('reads the audience in signup order, then the members changed since the run began', async () => {
		vi.useFakeTimers();
		try {
			const audience = audienceOf();
			const { emails, totals } = await walk(audience);

			expect(emails).toEqual(subscribedEmails(audience));
			const [first, second, third, closing] = audience.requests.map((url) =>
				Object.fromEntries(url.searchParams)
			);
			for (const page of [first, second, third]) {
				expect(page).toMatchObject({ sort_field: 'timestamp_signup', sort_dir: 'ASC' });
				expect(page).not.toHaveProperty('since_last_changed');
			}
			// Each later page re-reads the end of the one before it.
			expect(first).toMatchObject({ offset: '0', count: '100' });
			expect(second).toMatchObject({ offset: String(100 - PAGE_OVERLAP) });
			expect(closing).toMatchObject({ sort_field: 'last_changed', sort_dir: 'ASC', offset: '0' });
			// Five minutes before the first request, in Mailchimp's own format.
			expect(closing!['since_last_changed']).toBe(
				new Date(Date.now() - 5 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00')
			);
			expect(audience.requests).toHaveLength(4);
			// The closing pass's count is not the audience size.
			expect(totals).toEqual([250, 250, 250, undefined]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('imports every remaining member when one on an earlier page is deleted between pages', async () => {
		const audience = audienceOf();
		// Page one has been read; u10 is deleted before page two is requested.
		audience.onRequest((n) => {
			if (n === 2) audience.remove('u10@example.com');
		});

		const { emails } = await walk(audience);

		// u10 itself was read with page one, before it went.
		expect(emails).toEqual(expect.arrayContaining(subscribedEmails(audience)));
		expect(emails).toContain('u100@example.com');
		// The re-read end of page one is not imported twice.
		expect(emails).toHaveLength(250);
		expect(new Set(emails).size).toBe(250);
	});

	it('still imports every remaining member when the last member read is deleted too', async () => {
		const audience = audienceOf();
		audience.onRequest((n) => {
			if (n !== 2) return;
			for (let i = 100 - PAGE_OVERLAP; i < 100; i++) audience.remove(`u${i}@example.com`);
		});

		const { emails } = await walk(audience);

		expect(emails).toEqual(expect.arrayContaining(subscribedEmails(audience)));
		expect(new Set(emails).size).toBe(250);
	});

	it('carries over a member who unsubscribes after their page was read', async () => {
		const audience = audienceOf();
		audience.onRequest((n) => {
			if (n === 3) audience.setStatus('u5@example.com', 'unsubscribed');
		});

		const { suppressions } = await walk(audience);

		expect(suppressions).toEqual([
			{ email: 'u5@example.com', reason: 'unsubscribe', evidence: 'unsubscribed' },
		]);
	});

	it('imports a member who signs up during the run', async () => {
		const audience = audienceOf();
		audience.onRequest((n) => {
			if (n === 2) audience.add('late@example.com');
		});

		const { emails } = await walk(audience);

		expect(emails).toContain('late@example.com');
		expect(new Set(emails).size).toBe(251);
	});

	it('reads a one-page audience with one request', async () => {
		const audience = audienceOf(40);
		const { emails } = await walk(audience);
		expect(emails).toHaveLength(40);
		expect(audience.requests).toHaveLength(1);
	});

	it("finishes a run the previous release started at an offset in that release's order", async () => {
		const audience = audienceOf();
		global.fetch = audience.fetch;

		const second = await mailchimpProvider.fetchPage({ config: CONFIG, cursor: '100' });
		expect(second.nextCursor).toBe('200');
		const third = await mailchimpProvider.fetchPage({ config: CONFIG, cursor: '200' });
		expect(third.nextCursor).toBeNull();

		expect([...second.rows, ...third.rows]).toHaveLength(150);
		for (const url of audience.requests) {
			expect(url.searchParams.get('count')).toBe('100');
			expect(url.searchParams.has('sort_field')).toBe(false);
		}
	});

	it('rejects a cursor it did not write', async () => {
		global.fetch = audienceOf().fetch;
		await expect(
			mailchimpProvider.fetchPage({ config: CONFIG, cursor: '{"pass":"other"}' })
		).rejects.toThrow(/Unrecognized Mailchimp import cursor/);
	});
});

describe('mailchimp paging — through the walker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('INSTANCE_SECRET', 'live-paging-test-secret');
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	async function runImport(audience: FakeAudience) {
		global.fetch = audience.fetch;
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['imports.mailchimp']);
		const importId = await t.mutation(api.integrationImports.walker.startIntegrationImport, {
			config: CONFIG,
			handleDuplicates: 'skip',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const run = (await t.run(async (ctx) => ctx.db.get(importId))) as Doc<'integrationImports'>;
		const contacts = await t.run(async (ctx) => ctx.db.query('contacts').collect());
		return { run, contacts };
	}

	it('imports every remaining member when one is deleted between page 1 and page 2', async () => {
		const audience = audienceOf();
		audience.onRequest((n) => {
			if (n === 2) audience.remove('u10@example.com');
		});

		const { run, contacts } = await runImport(audience);

		expect(run.status).toBe('completed');
		// All 250: u10 was imported with page one, before it was deleted.
		expect(run.imported).toBe(250);
		expect(contacts.map((c) => c.email)).toEqual(
			expect.arrayContaining(subscribedEmails(audience))
		);
		expect(contacts.map((c) => c.email)).toContain('u100@example.com');
	});

	it('ends with a member who unsubscribed during the run unsubscribed here', async () => {
		const audience = audienceOf();
		audience.onRequest((n) => {
			if (n === 3) audience.setStatus('u5@example.com', 'unsubscribed');
		});

		const { run, contacts } = await runImport(audience);

		expect(run.status).toBe('completed');
		expect(run.imported).toBe(250);
		expect(run.suppressionCounts).toMatchObject({ unsubscribed: 1 });
		const departed = contacts.find((c) => c.email === 'u5@example.com');
		expect(departed?.unsubscribedAt).toBeGreaterThan(0);
	});
});
