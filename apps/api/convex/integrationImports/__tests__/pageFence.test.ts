/**
 * Integration import page fence (#996): a cancelled run writes nothing after
 * the cancel is accepted, and a page committed before it stays counted.
 *
 * The provider fetch is held open with a gate, so a cancel (through the real
 * public mutation) can land at a chosen moment of a real page action:
 *   - while the page is being fetched: nothing from the page may persist, not
 *     a contact, a topic membership, a DOI confirmation or a suppression;
 *   - while the page's contact stage is writing: the cancel waits for the page
 *     transaction, so the whole page (contacts AND suppressions) is applied and
 *     counted, and no later page runs;
 *   - before a replacement import starts: the old run's page must not write
 *     into the new run's window.
 *
 * `global.fetch` is the only fake; contact import, suppression carry-over,
 * cancellation and start run the real schema and functions.
 */

import { AsyncResource } from 'node:async_hooks';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import { createTestContact, enableFeatures } from '../../__tests__/factories';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
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

/** A page with contacts AND suppressions on it: two subscribers, one departure, one bounce. */
const MIXED_PAGE: Member[] = [
	{ email: 'a@example.com', status: 'subscribed' },
	{ email: 'b@example.com', status: 'subscribed' },
	{ email: 'gone@example.com', status: 'unsubscribed' },
	{ email: 'dead@example.com', status: 'cleaned' },
];

/** A provider fetch that does not answer until the test releases it. */
function gatedFetch(respond: () => Response) {
	let markStarted: () => void = () => undefined;
	let release: () => void = () => undefined;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	const gate = new Promise<void>((resolve) => (release = resolve));
	const fetch = vi.fn(async () => {
		markStarted();
		await gate;
		return respond();
	});
	return { fetch, started, release };
}

// Runs a callback in the test's own async context. Called from inside a
// function under test, it starts a NEW top-level transaction (which waits for
// the running one) instead of joining the caller's as a nested call.
const outsideTransaction = AsyncResource.bind((run: () => Promise<unknown>) => run());

/** Called after the page's contact-import stage has written, inside its transaction. */
let afterContactStage: (() => void) | null = null;

type Handler = (ctx: unknown, args: unknown) => Promise<unknown>;

/** The module map with `contacts/import:importBatch` instrumented. */
const instrumentedModules = {
	...modules,
	'../contacts/import.ts': async () => {
		const mod = (await modules['../contacts/import.ts']!()) as Record<string, unknown>;
		const real = mod['importBatch'] as { _handler: Handler };
		const _handler: Handler = async (ctx, args) => {
			const outcome = await real._handler(ctx, args);
			afterContactStage?.();
			return outcome;
		};
		return { ...mod, importBatch: Object.assign(() => undefined, real, { _handler }) };
	},
};

function newHarness() {
	return convexTest(schema, instrumentedModules);
}

async function seedRun(t: ReturnType<typeof newHarness>): Promise<Id<'integrationImports'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('integrationImports', {
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
			pagesCommitted: 0,
		})
	);
}

async function readRun(t: ReturnType<typeof newHarness>, id: Id<'integrationImports'>) {
	return (await t.run(async (ctx) => ctx.db.get(id))) as Doc<'integrationImports'>;
}

async function contactEmails(t: ReturnType<typeof newHarness>): Promise<string[]> {
	const contacts = await t.run(async (ctx) => ctx.db.query('contacts').collect());
	return contacts.map((c) => c.email ?? '').sort();
}

async function seedTopicAndDeparture(t: ReturnType<typeof newHarness>) {
	return await t.run(async (ctx) => {
		const topicId = await ctx.db.insert('topics', {
			name: 'newsletter',
			requireDoubleOptIn: true,
			createdAt: Date.now(),
		});
		// The departure is a contact here already, so carrying it over would
		// change it: the opt-out stamp is a visible effect.
		const goneId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'gone@example.com' }) as Doc<'contacts'>
		);
		await ctx.db.insert('contactTopics', { contactId: goneId, topicId, addedAt: Date.now() });
		return { topicId, goneId };
	});
}

const originalFetch = global.fetch;

beforeEach(() => {
	afterContactStage = null;
	vi.useFakeTimers();
});

afterEach(() => {
	afterContactStage = null;
	global.fetch = originalFetch;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('integration import page fence (#996)', () => {
	it('a cancel accepted during the provider fetch leaves no effect of that page', async () => {
		const t = newHarness();
		const { topicId, goneId } = await seedTopicAndDeparture(t);
		const importId = await seedRun(t);
		await t.run(async (ctx) => ctx.db.patch(importId, { topicId }));
		const provider = gatedFetch(() => membersResponse(MIXED_PAGE));
		global.fetch = provider.fetch;

		const page = t.action(internal.integrationImports.walker.processIntegrationPage, {
			importId,
			config: CONFIG,
			cursor: '',
			page: 0,
		});
		await provider.started;
		await t.mutation(api.integrationImports.walker.cancelImport, { importId });
		provider.release();
		await page;

		// No contact, no topic membership, no DOI confirmation.
		expect(await contactEmails(t)).toEqual(['gone@example.com']);
		await t.run(async (ctx) => {
			const memberships = await ctx.db.query('contactTopics').collect();
			expect(memberships.map((m) => m.contactId)).toEqual([goneId]);
			// No suppression: the departure was not opted out, the bounce not blocked.
			expect((await ctx.db.get(goneId))?.unsubscribedAt).toBeUndefined();
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
		});

		const run = await readRun(t, importId);
		expect(run.status).toBe('failed');
		expect(run.errors).toEqual(['Cancelled by user']);
		expect(run.imported).toBe(0);
		expect(run.suppressionCounts).toBeUndefined();
		expect(run.cursor).toBe('');
	});

	it('a cancel requested during the contact stage lands after the whole page, which stays counted', async () => {
		const t = newHarness();
		const importId = await seedRun(t);
		// A full page (100 members), so the run would continue past it.
		const members: Member[] = [
			...Array.from({ length: 98 }, (_, i) => ({
				email: `s${i}@example.com`,
				status: 'subscribed',
			})),
			{ email: 'gone@example.com', status: 'unsubscribed' },
			{ email: 'dead@example.com', status: 'cleaned' },
		];
		// Answers the provider and, after the page, the MTA suppression mirror.
		const fetchSpy = vi.fn(async (_url: unknown) => membersResponse(members, 300));
		global.fetch = fetchSpy;
		await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'gone@example.com' }) as Doc<'contacts'>)
		);

		let cancel: Promise<unknown> | null = null;
		afterContactStage = () => {
			afterContactStage = null;
			cancel = outsideTransaction(() =>
				t.mutation(api.integrationImports.walker.cancelImport, { importId })
			);
		};

		await t.action(internal.integrationImports.walker.processIntegrationPage, {
			importId,
			config: CONFIG,
			cursor: '',
			page: 0,
		});
		expect(cancel).not.toBeNull();
		await cancel;

		const run = await readRun(t, importId);
		expect(run.status).toBe('failed');
		expect(run.errors).toContain('Cancelled by user');
		// Every effect of the page is on the run: 98 new contacts (the departure
		// was already a contact and is not a subscriber row), one opt-out, one
		// hard bounce.
		expect(run.imported).toBe(98);
		expect(run.suppressionCounts).toMatchObject({ unsubscribed: 1, bouncedHard: 1 });
		await t.run(async (ctx) => {
			const blocked = await ctx.db.query('blockedEmails').collect();
			expect(blocked.map((b) => b.email)).toEqual(['dead@example.com']);
			// The cancelled run still reports what it carried over.
			const summaries = (await ctx.db.query('auditLogs').collect()).filter(
				(row) => row.action === 'blocklist.provider_import_summary'
			);
			expect(summaries).toHaveLength(1);
		});

		// The next page was scheduled with the commit; it finds the run ended
		// and does not fetch.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const providerCalls = fetchSpy.mock.calls.filter((call: unknown[]) =>
			String(call[0]).includes('api.mailchimp.com')
		);
		expect(providerCalls).toHaveLength(1);
		expect((await readRun(t, importId)).imported).toBe(98);
	});

	it('a replacement import never receives the cancelled run’s page', async () => {
		const t = newHarness();
		await enableFeatures(t, ['imports.mailchimp']);
		const first = await t.mutation(api.integrationImports.walker.startIntegrationImport, {
			config: CONFIG,
			handleDuplicates: 'skip',
		});
		const firstPage = gatedFetch(() =>
			membersResponse([
				{ email: 'old1@example.com', status: 'subscribed' },
				{ email: 'old2@example.com', status: 'cleaned' },
			])
		);
		global.fetch = firstPage.fetch;
		// The first run's hop, mid-fetch.
		const stale = t.action(internal.integrationImports.walker.processIntegrationPage, {
			importId: first,
			config: CONFIG,
			cursor: '',
			page: 0,
		});
		await firstPage.started;

		await t.mutation(api.integrationImports.walker.cancelImport, { importId: first });
		const second = await t.mutation(api.integrationImports.walker.startIntegrationImport, {
			config: CONFIG,
			handleDuplicates: 'skip',
		});

		firstPage.release();
		await stale;
		global.fetch = vi.fn(async () =>
			membersResponse([{ email: 'new1@example.com', status: 'subscribed' }])
		);
		// Both runs' queued first hops: the cancelled one's does nothing.
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await contactEmails(t)).toEqual(['new1@example.com']);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
		});
		const cancelled = await readRun(t, first);
		expect(cancelled.status).toBe('failed');
		expect(cancelled.imported).toBe(0);
		const replacement = await readRun(t, second);
		expect(replacement.status).toBe('completed');
		expect(replacement.imported).toBe(1);
	});

	it('a late commit or terminal patch cannot touch a cancelled run', async () => {
		const t = newHarness();
		const importId = await seedRun(t);
		await t.mutation(api.integrationImports.walker.cancelImport, { importId });

		const outcome = await t.mutation(internal.integrationImports.pageCommit.commitIntegrationPage, {
			importId,
			cursor: '',
			page: 0,
			config: CONFIG,
			rows: [{ email: 'late@example.com' }],
			suppressions: [{ email: 'late-bounce@example.com', reason: 'bounced', evidence: 'cleaned' }],
			suppressionsSkipped: 0,
			nextCursor: '100',
		});
		await t.mutation(internal.integrationImports.walker.completeImport, {
			importId,
			status: 'completed',
		});

		expect(outcome).toEqual({ isCommitted: false });
		expect(await contactEmails(t)).toEqual([]);
		const run = await readRun(t, importId);
		expect(run.status).toBe('failed');
		expect(run.errors).toEqual(['Cancelled by user']);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
			const hops = await ctx.db.system.query('_scheduled_functions').collect();
			expect(hops).toHaveLength(0);
		});
	});
});
