/**
 * Yahoo CFL guided enrollment — Convex integration (P4-6).
 *
 * Real table writes through the convex-test harness: the guided flow's four
 * states, the DKIM-domain precondition, the report observation that keeps the
 * enrollment live, the re-check that is DERIVED ON READ (there is no cron and no
 * re-check write — the lapse verdict is a function of `lastReportAt` and the
 * clock), and the D2 proof that a deployment which never enrolls renders cleanly
 * and gets the documented substitution instead of an error.
 *
 * Adversarial: an unknown domain, an oversized/malformed reported domain, a
 * replayed report, a non-finite/negative clock, a burst of reports that must
 * coalesce to a single write, and a foreign-org enrollment row.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { OrganizationRole } from '../../lib/sessionOrganization';
import { YAHOO_CFL_LAPSE_SILENCE_MS, YAHOO_CFL_REPORT_COALESCE_MS } from '@owlat/shared/yahooCfl';

let mockRole: OrganizationRole = 'admin';

function throwForbidden(): never {
	const err = new Error("You don't have permission to perform this action") as Error & {
		data?: { category: string };
	};
	err.data = { category: 'forbidden' };
	throw err;
}

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const ctx = () => ({ userId: 'test-user', role: mockRole, activeOrganizationId: 'org-a' });
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a'),
		requireOrgMember: vi.fn(async () => ctx()),
		getMutationContext: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') throwForbidden();
			return ctx();
		}),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = { ...rootGlob, ...domainsGlob };

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

const T0 = Date.UTC(2026, 6, 1);
const DAY = 24 * 60 * 60 * 1000;
const LAPSE_MS = YAHOO_CFL_LAPSE_SILENCE_MS;
const COALESCE_MS = YAHOO_CFL_REPORT_COALESCE_MS;

type Harness = TestConvex<typeof schema>;

async function seedDomain(
	t: Harness,
	opts: { domain: string; isVerified?: boolean; withSelector?: boolean }
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) => {
		const domainId = await ctx.db.insert('domains', {
			domain: opts.domain,
			status: opts.isVerified === false ? 'pending' : 'verified',
			dnsRecords: {},
			createdAt: T0,
			updatedAt: T0,
		});
		if (opts.withSelector !== false) {
			await ctx.db.insert('sendingDomainMtaIdentities', {
				domainId,
				dkimSelector: 's1711234567',
				createdAt: T0,
				updatedAt: T0,
			});
		}
		return domainId;
	});
}

/**
 * Seed a domain the operator HAS submitted to Yahoo.
 *
 * A report can only ever confirm an enrollment the operator started — an
 * internet-triggered path is never allowed to manufacture one — so every fixture
 * that exercises the observation write starts from `awaiting_yahoo`.
 */
async function seedSubmittedDomain(t: Harness, domain: string): Promise<Id<'domains'>> {
	const domainId = await seedDomain(t, { domain });
	await t.withIdentity(identity).mutation(api.domains.yahooCfl.submitEnrollment, { domainId });
	return domainId;
}

async function enrollmentRows(t: Harness) {
	return await t.run(async (ctx) => ctx.db.query('yahooCflEnrollments').collect());
}

beforeEach(() => {
	mockRole = 'admin';
	// The mutations read the wall clock (D15 keeps the clock OUT of the pure core,
	// so the shell is the only place it is read); pin it so each transition lands
	// on a known timestamp.
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the guided flow, end to end', () => {
	it('blocks submission until the DKIM domain is verified and signing', async () => {
		const t = convexTest(schema, modules);
		const unverified = await seedDomain(t, { domain: 'mail.a.test', isVerified: false });
		const asUser = t.withIdentity(identity);

		const refused = await asUser.mutation(api.domains.yahooCfl.submitEnrollment, {
			domainId: unverified,
		});
		expect(refused).toMatchObject({ changed: false, reason: 'dkim_domain_not_ready' });
		// A refused precondition writes nothing — absence stays absence.
		expect(await enrollmentRows(t)).toHaveLength(0);
	});

	it('walks not_started -> awaiting_yahoo -> enrolled and persists each step', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.b.test' });
		const asUser = t.withIdentity(identity);

		expect(
			await asUser.mutation(api.domains.yahooCfl.submitEnrollment, { domainId })
		).toMatchObject({ state: 'awaiting_yahoo', changed: true, reason: 'submitted' });
		expect(await enrollmentRows(t)).toMatchObject([
			{ organizationId: 'org-a', state: 'awaiting_yahoo', dkimDomain: 'mail.b.test' },
		]);

		vi.setSystemTime(T0 + DAY);
		expect(
			await asUser.mutation(api.domains.yahooCfl.confirmEnrollment, { domainId })
		).toMatchObject({ state: 'enrolled', changed: true, reason: 'confirmed' });
		const rows = await enrollmentRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ state: 'enrolled', enrolledAt: T0 + DAY });
	});

	it('resets back to not_started and clears the enrollment timestamps', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.c.test' });
		const asUser = t.withIdentity(identity);
		await asUser.mutation(api.domains.yahooCfl.submitEnrollment, { domainId });
		await asUser.mutation(api.domains.yahooCfl.confirmEnrollment, { domainId });

		vi.setSystemTime(T0 + 2 * DAY);
		expect(await asUser.mutation(api.domains.yahooCfl.resetEnrollment, { domainId })).toMatchObject(
			{ state: 'not_started', changed: true, reason: 'reset' }
		);
		const rows = await enrollmentRows(t);
		expect(rows[0]).toMatchObject({ state: 'not_started', updatedAt: T0 + 2 * DAY });
		expect(rows[0]?.enrolledAt).toBeUndefined();
		expect(rows[0]?.submittedAt).toBeUndefined();
	});

	it('refuses the write for a role without organization:manage', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.d.test' });
		mockRole = 'editor';
		await expect(
			t.withIdentity(identity).mutation(api.domains.yahooCfl.submitEnrollment, { domainId })
		).rejects.toThrow(/permission/i);
	});

	it('serves the guide with derived step statuses', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.e.test' });
		const asUser = t.withIdentity(identity);
		await asUser.mutation(api.domains.yahooCfl.submitEnrollment, { domainId });

		const guide = await asUser.query(api.domains.yahooCfl.getGuide, { domainId });
		expect(guide).not.toBeNull();
		expect(guide?.state).toBe('awaiting_yahoo');
		expect(guide?.precondition).toMatchObject({
			domain: 'mail.e.test',
			isVerified: true,
			dkimSelector: 's1711234567',
		});
		expect(guide?.steps.map((s) => s.status)).toEqual(['done', 'done', 'in_progress', 'blocked']);
	});

	it('returns null for a domain that no longer exists', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.f.test' });
		await t.run(async (ctx) => ctx.db.delete(domainId));
		expect(
			await t.withIdentity(identity).query(api.domains.yahooCfl.getGuide, { domainId })
		).toBeNull();
	});

	it('reports domain_missing — not dkim_domain_not_ready — for a deleted domain', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.f2.test' });
		await t.run(async (ctx) => ctx.db.delete(domainId));
		// Telling the operator to publish a DKIM record for a domain that no longer
		// exists is advice they cannot act on.
		expect(
			await t.withIdentity(identity).mutation(api.domains.yahooCfl.submitEnrollment, { domainId })
		).toMatchObject({ state: 'not_started', changed: false, reason: 'domain_missing' });
		expect(await enrollmentRows(t)).toHaveLength(0);
	});
});

describe('report observation keeps the enrollment live', () => {
	it('promotes an awaiting enrollment to enrolled on the first report', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.g.test' });
		await t.withIdentity(identity).mutation(api.domains.yahooCfl.submitEnrollment, { domainId });

		const result = await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'MAIL.G.TEST',
			at: T0 + DAY,
		});
		expect(result).toMatchObject({ matchedDomain: true, changed: true, state: 'enrolled' });
		expect((await enrollmentRows(t))[0]).toMatchObject({
			state: 'enrolled',
			lastReportAt: T0 + DAY,
		});
	});

	it('never creates a row from a report alone — an internet-triggered path cannot enroll', async () => {
		// ADVERSARIAL. Both facts the observation gates on are report-supplied, and
		// the only authentication upstream is a VERP-attributed message id every
		// recipient of every send already holds. So a crafted report must not be able
		// to manufacture an enrollment (and with it the looser direct complaint
		// threshold at `confidence: 'high'`) for a domain nobody enrolled.
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.h.test' });
		const result = await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.h.test',
			at: T0,
		});
		// The OUTCOME, not a flag: the domain matched, and the transition was
		// refused, so nothing was written.
		expect(result).toEqual({
			matchedDomain: true,
			changed: false,
			state: 'not_started',
			reason: 'not_submitted',
		});
		expect(await enrollmentRows(t)).toHaveLength(0);

		// And the guide the operator sees still reports the substituted proxy.
		const guide = await t.withIdentity(identity).query(api.domains.yahooCfl.getGuide, { domainId });
		expect(guide?.state).toBe('not_started');
		expect(guide?.complaintSignal.confidence).toBe('low');
		expect(guide?.complaintSignal.source).toBe('unsubscribe_rate_proxy');
	});

	it('is a silent no-op for a domain this deployment does not send from', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'mail.i.test' });
		expect(
			await t.mutation(internal.domains.yahooCfl.observeReport, {
				reportedDomain: 'someone-elses.example',
				at: T0,
			})
		).toEqual({ matchedDomain: false, changed: false, reason: 'domain_missing' });
		expect(await enrollmentRows(t)).toHaveLength(0);
	});

	it('bounds an empty or oversized reported domain without touching the DB', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'mail.j.test' });
		for (const reportedDomain of ['', '   ', `${'a'.repeat(300)}.example`]) {
			expect(
				await t.mutation(internal.domains.yahooCfl.observeReport, { reportedDomain, at: T0 })
			).toEqual({ matchedDomain: false, changed: false, reason: 'domain_missing' });
		}
		expect(await enrollmentRows(t)).toHaveLength(0);
	});

	it('does not rewind lastReportAt on a replayed, out-of-order report', async () => {
		const t = convexTest(schema, modules);
		await seedSubmittedDomain(t, 'mail.k.test');
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.k.test',
			at: T0 + 10 * DAY,
		});
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.k.test',
			at: T0 + 2 * DAY,
		});
		const rows = await enrollmentRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.lastReportAt).toBe(T0 + 10 * DAY);
	});

	it('COALESCES a burst of complaints into a single row patch (D16 / ADR-0042)', async () => {
		const t = convexTest(schema, modules);
		await seedSubmittedDomain(t, 'mail.burst.test');
		// First report creates the row.
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.burst.test',
			at: T0,
		});
		const created = (await enrollmentRows(t))[0];
		expect(created?.updatedAt).toBe(T0);

		// A realistic burst: 50 complaints for the same domain inside one minute.
		// Every report for a domain lands on THIS row, so a per-report patch is the
		// single-document OCC contention ADR-0042 was written about.
		for (let i = 1; i <= 50; i++) {
			expect(
				await t.mutation(internal.domains.yahooCfl.observeReport, {
					reportedDomain: 'mail.burst.test',
					at: T0 + i * 1000,
				})
			).toMatchObject({ matchedDomain: true, changed: false, state: 'enrolled' });
		}
		const afterBurst = (await enrollmentRows(t))[0];
		// Not one patch per complaint: the row is untouched since creation.
		expect(afterBurst?.updatedAt).toBe(T0);
		expect(afterBurst?.lastReportAt).toBe(T0);

		// Once the liveness timestamp actually moves by a full coalesce window, the
		// write happens — the 90-day derived lapse is unaffected by the coalescing.
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.burst.test',
			at: T0 + COALESCE_MS,
		});
		const advanced = (await enrollmentRows(t))[0];
		expect(advanced?.lastReportAt).toBe(T0 + COALESCE_MS);
		expect(advanced?.updatedAt).toBe(T0 + COALESCE_MS);
		// Still exactly one row throughout.
		expect(await enrollmentRows(t)).toHaveLength(1);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, -Number.MAX_SAFE_INTEGER])(
		'refuses a non-finite or non-positive `at` (%s) instead of pinning the row',
		async (at) => {
			const t = convexTest(schema, modules);
			await seedDomain(t, { domain: 'mail.clock.test' });
			// This mutation is reachable from an internet-triggered path, so the clock
			// it is handed is untrusted. `Math.max` would absorb Infinity and pin the
			// record permanently `enrolled` / never `lapsed`, holding the yahoo
			// complaint gate on the looser direct threshold forever.
			expect(
				await t.mutation(internal.domains.yahooCfl.observeReport, {
					reportedDomain: 'mail.clock.test',
					at,
				})
			).toEqual({ matchedDomain: false, changed: false, reason: 'invalid_timestamp' });
			expect(await enrollmentRows(t)).toHaveLength(0);
		}
	);

	it('leaves an existing row untouched when a garbage clock arrives', async () => {
		const t = convexTest(schema, modules);
		await seedSubmittedDomain(t, 'mail.clock2.test');
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.clock2.test',
			at: T0,
		});
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.clock2.test',
			at: Number.POSITIVE_INFINITY,
		});
		expect((await enrollmentRows(t))[0]).toMatchObject({ lastReportAt: T0, updatedAt: T0 });
	});

	it('never touches another organization row: a foreign enrollment stays untouched', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSubmittedDomain(t, 'mail.l.test');
		const foreignId = await t.run(async (ctx) =>
			ctx.db.insert('yahooCflEnrollments', {
				organizationId: 'org-other',
				domainId,
				state: 'not_started',
				createdAt: T0,
				updatedAt: T0,
			})
		);

		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.l.test',
			at: T0 + DAY,
		});

		const foreign = await t.run(async (ctx) => ctx.db.get(foreignId));
		expect(foreign).toMatchObject({
			organizationId: 'org-other',
			state: 'not_started',
			updatedAt: T0,
		});
		expect(foreign?.lastReportAt).toBeUndefined();
		const ours = (await enrollmentRows(t)).filter((r) => r.organizationId === 'org-a');
		expect(ours).toHaveLength(1);
		expect(ours[0]).toMatchObject({ state: 'enrolled' });
	});
});

describe('the re-check, derived on read', () => {
	it('reads as lapsed after 90 silent days without any write or cron', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSubmittedDomain(t, 'mail.m.test');
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.m.test',
			at: T0,
		});
		const asUser = t.withIdentity(identity);

		vi.setSystemTime(T0 + LAPSE_MS - DAY);
		expect(await asUser.query(api.domains.yahooCfl.getGuide, { domainId })).toMatchObject({
			state: 'enrolled',
			enrollment: { state: 'enrolled' },
		});

		vi.setSystemTime(T0 + LAPSE_MS);
		const lapsed = await asUser.query(api.domains.yahooCfl.getGuide, { domainId });
		// The DERIVED state is `lapsed` while the STORED one is still `enrolled` —
		// reported once each, from one source (`state` vs `enrollment.state`).
		expect(lapsed).toMatchObject({
			state: 'lapsed',
			enrollment: { state: 'enrolled' },
			silentMs: LAPSE_MS,
		});
		// The verdict is derived: the stored row was never rewritten.
		expect((await enrollmentRows(t))[0]).toMatchObject({ state: 'enrolled', updatedAt: T0 });
	});

	it('un-lapses the moment a report finally arrives', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSubmittedDomain(t, 'mail.o.test');
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.o.test',
			at: T0,
		});
		const asUser = t.withIdentity(identity);
		vi.setSystemTime(T0 + LAPSE_MS);
		expect((await asUser.query(api.domains.yahooCfl.getGuide, { domainId }))?.state).toBe('lapsed');

		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.o.test',
			at: T0 + LAPSE_MS,
		});
		expect((await asUser.query(api.domains.yahooCfl.getGuide, { domainId }))?.state).toBe(
			'enrolled'
		);
	});

	it('RE-SUBMITS a lapsed enrollment: the guide offers it and the mutation changes the row', async () => {
		// The "re-check it" acceptance criterion, end to end. A lapsed domain's
		// STORED state is `enrolled`, so re-submission must be keyed on the DERIVED
		// state or the control is dead: it would write nothing, refresh no
		// `submittedAt`, and say nothing (a refusal is a reason, not a throw).
		const t = convexTest(schema, modules);
		const domainId = await seedSubmittedDomain(t, 'mail.relapse.test');
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.relapse.test',
			at: T0,
		});
		const asUser = t.withIdentity(identity);

		// While the enrollment is live, submit is neither offered nor accepted.
		vi.setSystemTime(T0 + DAY);
		const live = await asUser.query(api.domains.yahooCfl.getGuide, { domainId });
		expect(live?.actions).toMatchObject({ canSubmit: false, canConfirm: false, canReset: true });
		expect(
			await asUser.mutation(api.domains.yahooCfl.submitEnrollment, { domainId })
		).toMatchObject({ changed: false, reason: 'already_enrolled' });

		// Once it derives as lapsed, the affordance comes back...
		const lapsedAt = T0 + LAPSE_MS;
		vi.setSystemTime(lapsedAt);
		const lapsed = await asUser.query(api.domains.yahooCfl.getGuide, { domainId });
		expect(lapsed?.state).toBe('lapsed');
		expect(lapsed?.actions).toMatchObject({ canSubmit: true, submitBlockedByDkim: false });
		expect(lapsed?.steps.find((s) => s.id === 'submit_enrollment')?.status).toBe('todo');

		// ...and the mutation has a real EFFECT: back to awaiting_yahoo with a fresh
		// submittedAt, the observed history kept, the stale confirmation date gone.
		expect(
			await asUser.mutation(api.domains.yahooCfl.submitEnrollment, { domainId })
		).toMatchObject({ state: 'awaiting_yahoo', changed: true, reason: 'resubmitted' });
		const row = (await enrollmentRows(t))[0];
		expect(row).toMatchObject({
			state: 'awaiting_yahoo',
			submittedAt: lapsedAt,
			lastReportAt: T0,
			updatedAt: lapsedAt,
		});
		expect(row?.enrolledAt).toBeUndefined();

		// The guide now shows the waiting state and offers confirm instead.
		const after = await asUser.query(api.domains.yahooCfl.getGuide, { domainId });
		expect(after?.state).toBe('awaiting_yahoo');
		expect(after?.actions).toMatchObject({ canSubmit: false, canConfirm: true, canReset: true });
		// And the fourth step goes BACK to waiting rather than staying `done` off the
		// kept `lastReportAt` — a re-submitted enrollment is not attributing
		// complaints until one arrives for THIS submission.
		expect(after?.steps.map((s) => s.status)).toEqual(['done', 'done', 'in_progress', 'blocked']);
		expect(after?.steps.find((s) => s.id === 'watch_reports')?.verification).toContain(
			'will appear on the delivery screens'
		);

		// A fresh report closes it again.
		vi.setSystemTime(lapsedAt + DAY);
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.relapse.test',
			at: lapsedAt + DAY,
		});
		const reported = await asUser.query(api.domains.yahooCfl.getGuide, { domainId });
		expect(reported?.state).toBe('enrolled');
		expect(reported?.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
	});

	it('never reads as lapsed for a state that was never enrolled', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.n.test' });
		const asUser = t.withIdentity(identity);
		await asUser.mutation(api.domains.yahooCfl.submitEnrollment, { domainId });
		vi.setSystemTime(T0 + 10 * LAPSE_MS);
		expect((await asUser.query(api.domains.yahooCfl.getGuide, { domainId }))?.state).toBe(
			'awaiting_yahoo'
		);
	});
});

describe('D2 — never enrolling is a supported configuration', () => {
	it('serves the guide with the tightened proxy substitution and no error state', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.p.test' });
		const guide = await t.withIdentity(identity).query(api.domains.yahooCfl.getGuide, { domainId });
		expect(guide?.state).toBe('not_started');
		expect(guide?.complaintSignal).toMatchObject({
			source: 'unsubscribe_rate_proxy',
			thresholdRate: 0.0005,
			confidence: 'low',
			isBlocking: false,
		});
		expect(guide?.complaintSignal.confidenceNote).toContain('Measurement confidence: low');
		expect(guide?.complaintSignal.caveat).toContain('would measure complaints directly');
		// Reading the guide writes nothing: absence is not a row to be created.
		expect(await enrollmentRows(t)).toHaveLength(0);
	});

	it('resolves the CFBL substitution SERVER-side, never from a client arg', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { domain: 'mail.q.test' });
		// `getGuide` takes only a domain id. The CFBL-Address feed lands with P2-7;
		// until then the server answers `false` itself, so a caller cannot steer the
		// reported confidence or the displayed threshold (D20 — no speculative seam).
		const guide = await t.withIdentity(identity).query(api.domains.yahooCfl.getGuide, { domainId });
		expect(guide?.complaintSignal).toMatchObject({
			source: 'unsubscribe_rate_proxy',
			confidence: 'low',
			isBlocking: false,
		});
	});

	it('reports the yahoo CFL source at full confidence once enrolled', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSubmittedDomain(t, 'mail.r.test');
		await t.mutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: 'mail.r.test',
			at: T0,
		});
		const guide = await t.withIdentity(identity).query(api.domains.yahooCfl.getGuide, { domainId });
		expect(guide?.complaintSignal).toMatchObject({ source: 'yahoo_cfl', confidence: 'high' });
	});
});
