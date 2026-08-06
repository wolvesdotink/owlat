/**
 * smtpResponseCategories — the transport-telemetry surface that closes issue
 * #501.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and therefore what this suite is about:
 *
 *   - THE WRITE LANDS AT ALL. The MTA reports a category against a MESSAGE ID
 *     and knows neither the cell nor the arm; if the join through
 *     `sendAssignments` misses, the counter is silently never written and gate
 *     2's block clause is exactly as dormant as it was before the wire existed.
 *     So the cases drive the real `recordClassifiedResponse` mutation over real
 *     seeded sends rather than calling the cell-level writer directly.
 *   - ABSENCE IS NOT A ZERO. This is the entire point of the wave the issue came
 *     from: a window with no rows must summarize to `null` ("we did not
 *     measure"), and a window with rows and no refusals in them must summarize
 *     to an observation whose block count is zero ("we measured, and nobody is
 *     refusing us"). The gate reads those two as opposite facts.
 *   - BOTH WINDOWS COME OFF ONE READ. The controller judges 24 hours and the
 *     dashboard reports seven days, so the summarizer is exercised over both
 *     spans of the same rows.
 *   - THE COUNTER IS SHARDED AND THE READ SUMS (ADR-0042). Concurrent responses
 *     must not lose counts to a single-document read-modify-write.
 *   - THE TABLE IS TENANT DATA. A second org's rows may not reach this org's
 *     summary, and an organization wipe must take these rows with it.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { startOfDayUtc } from '../../lib/clock';
import { TENANT_TABLES } from '../../lib/tenantTables';
import {
	readCellArmCategoryBuckets,
	recordSmtpResponseForCell,
	summarizeSmtpBlockObservation,
	SMTP_RESPONSE_CATEGORY_CLEANUP_BATCH_SIZE,
	SMTP_RESPONSE_CATEGORY_RETENTION_MS,
	type SmtpCategoryBucket,
} from '../smtpResponseCategories';
import {
	DAY_MS,
	GMAIL_CAMPAIGN_CELL,
	MICROSOFT_CAMPAIGN_CELL,
	OTHER_ORG,
	OUTCOME_ORG,
	seedAssignedSend,
} from './transportOutcomesFixtures';

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness — the same override every other writer
// suite in this folder uses.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const TODAY = startOfDayUtc(NOW);

function harness() {
	return convexTest(schema, modules);
}

/** Every stored shard row, unfiltered — the writer's whole footprint. */
async function allRows(t: ReturnType<typeof harness>) {
	return await t.run(async (ctx) => await ctx.db.query('smtpResponseCategories').collect());
}

/** One (org, cell, arm) window, read through the production reader. */
async function observe(
	t: ReturnType<typeof harness>,
	window: { since?: number; until?: number },
	input: { organizationId?: string; cell?: string; arm?: 'own' | 'reference' } = {}
) {
	return await t.run(async (ctx) =>
		summarizeSmtpBlockObservation(
			await readCellArmCategoryBuckets(ctx.db, {
				organizationId: input.organizationId ?? OUTCOME_ORG,
				cell: (input.cell ?? GMAIL_CAMPAIGN_CELL) as typeof GMAIL_CAMPAIGN_CELL,
				arm: input.arm ?? 'own',
				...window,
			}),
			window
		)
	);
}

describe('the classified response reaches a counter at all', () => {
	it('joins the MTA message id to the send’s cell and arm', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedAssignedSend(ctx, {
				providerMessageId: 'mta-msg-1',
				assignment: { cell: GMAIL_CAMPAIGN_CELL, arm: 'own' },
			});
		});

		const { result } = await t.mutation(
			internal.analytics.smtpResponseCategories.recordClassifiedResponse,
			{ providerMessageId: 'mta-msg-1', category: 'content_rejected', observedAt: NOW }
		);
		expect(result).toBe('recorded');

		const rows = await allRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			organizationId: OUTCOME_ORG,
			cell: GMAIL_CAMPAIGN_CELL,
			arm: 'own',
			periodStart: TODAY,
			observed: 1,
			byCategory: { content_rejected: 1 },
			lastRecordedAt: NOW,
		});
	});

	it('takes the ARM from the assignment row and never from the transport that reported', async () => {
		// The MTA is the only thing that can classify an SMTP response, so it would
		// be easy — and wrong — to conclude that every classified response is the
		// `own` arm. The arm is a property of the ASSIGNMENT: a relay that grew a
		// classifier of its own would report against the arm it actually carried.
		const t = harness();
		await t.run(async (ctx) => {
			await seedAssignedSend(ctx, {
				providerMessageId: 'mta-msg-ref',
				assignment: { cell: GMAIL_CAMPAIGN_CELL, arm: 'reference' },
			});
		});
		await t.mutation(internal.analytics.smtpResponseCategories.recordClassifiedResponse, {
			providerMessageId: 'mta-msg-ref',
			category: 'policy_rejected',
			observedAt: NOW,
		});

		const rows = await allRows(t);
		expect(rows.map((row) => row.arm)).toEqual(['reference']);
		// And the OWN arm of the same cell is untouched — absence, not a zero.
		expect(await observe(t, { since: NOW - DAY_MS }, { arm: 'own' })).toBeNull();
	});

	it('records NOTHING for a send outside the experiment, and says which', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			// No assignment row: a seed shadow copy (plan D18) or a legacy send. It
			// must never enter a denominator.
			await seedAssignedSend(ctx, { providerMessageId: 'mta-msg-unassigned' });
		});

		expect(
			await t.mutation(internal.analytics.smtpResponseCategories.recordClassifiedResponse, {
				providerMessageId: 'mta-msg-unassigned',
				category: 'greylisted',
				observedAt: NOW,
			})
		).toEqual({ result: 'no_assignment' });
		// A message this deployment has no send row for at all.
		expect(
			await t.mutation(internal.analytics.smtpResponseCategories.recordClassifiedResponse, {
				providerMessageId: 'mta-msg-unknown',
				category: 'greylisted',
				observedAt: NOW,
			})
		).toEqual({ result: 'send_not_found' });
		expect(await allRows(t)).toEqual([]);
	});

	it('refuses a category outside the shared vocabulary at the wire boundary', async () => {
		// The handler swallows its own failures, so a throw can only come from the
		// argument validator — which is the last thing holding a stored map key to
		// `@owlat/shared/smtpBlockCategories`.
		const t = harness();
		await expect(
			t.mutation(internal.analytics.smtpResponseCategories.recordClassifiedResponse, {
				providerMessageId: 'mta-msg-1',
				// @ts-expect-error — the point of the case: the validator is the guard.
				category: 'definitely_not_a_category',
				observedAt: NOW,
			})
		).rejects.toThrow();
	});

	it('counts every RESPONSE, not every message — a message deferred twice counts twice', async () => {
		// A greylisted message collects a new classified response on every attempt,
		// and the gate's denominator is responses. Counting once per message would
		// under-report the denominator and inflate the block rate above it.
		const t = harness();
		await t.run(async (ctx) => {
			await seedAssignedSend(ctx, {
				providerMessageId: 'mta-msg-retry',
				assignment: { cell: GMAIL_CAMPAIGN_CELL, arm: 'own' },
			});
		});
		for (const at of [NOW, NOW + 60_000, NOW + 120_000]) {
			await t.mutation(internal.analytics.smtpResponseCategories.recordClassifiedResponse, {
				providerMessageId: 'mta-msg-retry',
				category: 'greylisted',
				observedAt: at,
			});
		}

		const observation = await observe(t, { since: NOW - DAY_MS });
		expect(observation?.observed).toBe(3);
		expect(observation?.blockedByCategory).toEqual({ greylisted: 3 });
	});
});

describe('absence and a measured zero are different facts', () => {
	it('summarizes an empty window to NULL, never to a zeroed observation', async () => {
		const t = harness();
		expect(await observe(t, { since: NOW - DAY_MS })).toBeNull();
		expect(await observe(t, {})).toBeNull();
	});

	it('summarizes a window of pure rate pressure to a MEASURED zero', async () => {
		// Rows exist, so the deployment answered — and none of the categories in
		// them is a refusal, so the block numerator is zero. That is the opposite
		// fact from the case above and the gate reads it as such: the clause has a
		// denominator, derives 0%, and declines to halt.
		const t = harness();
		await t.run(async (ctx) => {
			for (const category of ['greylisted', 'rate_limited', 'mailbox_full'] as const) {
				await recordSmtpResponseForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					category,
					now: NOW,
				});
			}
		});

		const observation = await observe(t, { since: NOW - DAY_MS });
		expect(observation).not.toBeNull();
		expect(observation?.observed).toBe(3);
		// The whole vocabulary is carried, not only the block subset: the audit row
		// (plan D12) is better for knowing the window was all throttling.
		expect(observation?.blockedByCategory).toEqual({
			greylisted: 1,
			rate_limited: 1,
			mailbox_full: 1,
		});
	});

	it('makes the distinction in the SUMMARIZER, over rows a caller cannot fake away', () => {
		// Driven directly on the pure core, so the rule is pinned independently of
		// any database: no rows in the window is `null`; a row in the window whose
		// counts are all zero is an observation.
		const zeroed: SmtpCategoryBucket = {
			periodStart: TODAY,
			observed: 0,
			byCategory: {},
			lastRecordedAt: NOW,
		};
		expect(summarizeSmtpBlockObservation([], { since: TODAY })).toBeNull();
		// A row OUTSIDE the window is absence too — a stale day may not vouch for a
		// window nothing was recorded in.
		expect(summarizeSmtpBlockObservation([zeroed], { since: TODAY + DAY_MS })).toBeNull();
		expect(summarizeSmtpBlockObservation([zeroed], { since: TODAY })).toEqual({
			observed: 0,
			blockedByCategory: {},
			observedAt: NOW,
		});
	});

	it('drops a stored key the vocabulary no longer recognises, and keeps the denominator', () => {
		// The stored map is `v.record(v.string(), …)`, so the row read is the one
		// place a key is narrowed. An unrecognised key must not become an invisible
		// passenger in a numerator — and must not shrink `observed`, which is its
		// own column precisely so it cannot be re-derived from the map.
		const row: SmtpCategoryBucket = {
			periodStart: TODAY,
			observed: 4,
			byCategory: { content_rejected: 1, from_a_future_release: 3 },
			lastRecordedAt: NOW,
		};
		expect(summarizeSmtpBlockObservation([row], { since: TODAY })).toEqual({
			observed: 4,
			blockedByCategory: { content_rejected: 1 },
			observedAt: NOW,
		});
	});
});

describe('one read, both readers’ windows', () => {
	/** Four days of rows: one refusal today, rate pressure on days 1..3. */
	async function seedFourDays(t: ReturnType<typeof harness>) {
		await t.run(async (ctx) => {
			await recordSmtpResponseForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				category: 'content_rejected',
				now: NOW,
			});
			for (const daysAgo of [1, 2, 3]) {
				await recordSmtpResponseForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					category: 'greylisted',
					now: NOW - daysAgo * DAY_MS,
				});
			}
		});
	}

	it('gives the controller its 24 hours and the dashboard its seven days off the same rows', async () => {
		const t = harness();
		await seedFourDays(t);

		// THE CONTROLLER'S SPAN, spelled the way `loadCellInput` spells it. The
		// shared bound helper FLOORS `since` to its UTC day — buckets are daily, so
		// there is no finer answer to give — which is why a 24-hour window anchored
		// at noon covers today and yesterday. That is the same rule the outcome
		// counters it is read beside follow, and the reason both are day-bucketed.
		const controller = await observe(t, { since: NOW - DAY_MS });
		expect(controller).toEqual({
			observed: 2,
			blockedByCategory: { content_rejected: 1, greylisted: 1 },
			observedAt: NOW,
		});
		// Anchored on the UTC day instead, it is today alone.
		expect(await observe(t, { since: TODAY })).toEqual({
			observed: 1,
			blockedByCategory: { content_rejected: 1 },
			observedAt: NOW,
		});

		// The dashboard's span: the same rows, four days of them.
		const dashboard = await observe(t, { since: TODAY - 6 * DAY_MS, until: TODAY + DAY_MS });
		expect(dashboard).toEqual({
			observed: 4,
			blockedByCategory: { content_rejected: 1, greylisted: 3 },
			observedAt: NOW,
		});
		// THE STAMP IS THE NEWEST ROW in both, not the oldest: a wider window may
		// not make a freshly-answered cell look stale.
		expect(dashboard?.observedAt).toBe(controller?.observedAt);
	});

	it('is bounded to its own window at both edges', async () => {
		const t = harness();
		await seedFourDays(t);
		// A window entirely in the past sees only what it covers.
		expect(await observe(t, { since: TODAY - 2 * DAY_MS, until: TODAY })).toEqual({
			observed: 2,
			blockedByCategory: { greylisted: 2 },
			observedAt: NOW - DAY_MS,
		});
		// A window entirely in the future is absence, not a zero.
		expect(await observe(t, { since: TODAY + DAY_MS })).toBeNull();
	});
});

describe('the counter is sharded and the read sums (ADR-0042)', () => {
	it('loses no count when many responses land on one bucket', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			for (let index = 0; index < 40; index += 1) {
				await recordSmtpResponseForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					category: index % 4 === 0 ? 'content_rejected' : 'rate_limited',
					now: NOW,
				});
			}
		});

		const rows = await allRows(t);
		// The split is real — otherwise this suite would be pinning a single-row
		// counter and calling it sharded — and invisible to the reader.
		expect(rows.length).toBeGreaterThan(1);
		expect(new Set(rows.map((row) => row.periodStart))).toEqual(new Set([TODAY]));
		expect(await observe(t, { since: NOW - DAY_MS })).toEqual({
			observed: 40,
			blockedByCategory: { content_rejected: 10, rate_limited: 30 },
			observedAt: NOW,
		});
	});

	it('writes the denominator and the category in ONE patch', async () => {
		// `blockRate` treats "more blocks than responses" as a producer bug and
		// refuses to derive a rate from it rather than clamping — so a writer that
		// could move one without the other would silently disable the clause.
		const t = harness();
		await t.run(async (ctx) => {
			await recordSmtpResponseForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				category: 'gmail_ip_identity',
				now: NOW,
			});
		});
		for (const row of await allRows(t)) {
			const named = Object.values(row.byCategory).reduce((sum, count) => sum + count, 0);
			expect(named).toBe(row.observed);
		}
	});
});

describe('the rows are tenant data', () => {
	it('never sums another tenant’s responses into this one’s window', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await recordSmtpResponseForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				category: 'greylisted',
				now: NOW,
			});
			await recordSmtpResponseForCell(ctx, {
				organizationId: OTHER_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				category: 'content_rejected',
				now: NOW,
			});
			// And a different CELL of this tenant, which is a different question.
			await recordSmtpResponseForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: MICROSOFT_CAMPAIGN_CELL,
				arm: 'own',
				category: 'content_rejected',
				now: NOW,
			});
		});

		expect(await observe(t, { since: NOW - DAY_MS })).toEqual({
			observed: 1,
			blockedByCategory: { greylisted: 1 },
			observedAt: NOW,
		});
	});

	it('is classified as tenant data and swept by the organization walker', async () => {
		expect(TENANT_TABLES).toContain('smtpResponseCategories');

		const t = harness();
		await t.run(async (ctx) => {
			await recordSmtpResponseForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				category: 'greylisted',
				now: NOW,
			});
		});
		expect(await allRows(t)).toHaveLength(1);

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'smtpResponseCategories',
		});
		expect(await allRows(t)).toEqual([]);
	});

	it('declares every caller-reachable index org-leading', async () => {
		// Read off the schema source rather than hand-listed, and EXHAUSTIVE: an
		// index nobody reads on a table written once per SMTP response is the write
		// amplification D16 exists to bound.
		const { readFileSync } = await import('node:fs');
		const { dirname, join } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				'..',
				'..',
				'schema',
				'smtpResponseCategories.ts'
			),
			'utf8'
		);
		const declared = [...source.matchAll(/\.index\('([^']+)',\s*\[([^\]]*)\]/g)].map((match) => ({
			name: match[1] ?? '',
			fields: (match[2] ?? '')
				.split(',')
				.map((field) => field.trim().replace(/^'|'$/g, ''))
				.filter((field) => field.length > 0),
		}));
		expect(declared.map((index) => index.name)).toEqual([
			'by_org_cell_arm_period_shard',
			'by_period_start',
		]);
		expect(declared[0]?.fields[0]).toBe('organizationId');
		// The one exemption, and the reason: the aging sweep is deployment-wide and
		// must not have to enumerate orgs to find old buckets. It is reachable only
		// from the internal cron.
		expect(declared[1]?.fields).toEqual(['periodStart']);
	});
});

describe('the aging sweep', () => {
	it('drops buckets past the retention horizon and keeps the rest', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await recordSmtpResponseForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				category: 'greylisted',
				now: NOW - SMTP_RESPONSE_CATEGORY_RETENTION_MS - DAY_MS,
			});
			await recordSmtpResponseForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				category: 'greylisted',
				now: NOW,
			});
		});
		expect(await allRows(t)).toHaveLength(2);

		const { deleted } = await t.mutation(
			internal.analytics.smtpResponseCategories.cleanupExpiredSmtpResponses,
			{ now: NOW }
		);
		expect(deleted).toBe(1);
		expect((await allRows(t)).map((row) => row.periodStart)).toEqual([TODAY]);
		// A tick that comes back short does not reschedule itself.
		expect(deleted).toBeLessThan(SMTP_RESPONSE_CATEGORY_CLEANUP_BATCH_SIZE);
	});
});
