/**
 * Audience resolution (module) tests — ADR-0033.
 *
 * The interface is the test surface:
 *  1. `selectRecipient` pure unit tests (the deep core, no harness).
 *  2. Anti-drift: `countRecipients(a).eligible === resolveRecipients(a).length`.
 *  3. Soft-delete regression: a soft-deleted Contact appears in neither entry.
 *  4. DOI asymmetry: DOI-pending is excluded from a DOI-required topic but
 *     included in a matching segment.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { selectRecipient } from '../audienceResolution';
import {
	createTestContact,
	createTestTopic,
	createTestBlockedEmail,
} from '../../__tests__/factories';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

// Vite canonicalizes glob keys for files in this subtree: a sibling at
// convex/campaigns/X is keyed as '../X' rather than '../../campaigns/X'.
// convex-test computes its lookup prefix from '../../_generated/...', so the
// canonicalized keys would never match. Re-prefix the canonicalized half.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../campaigns/' + key.slice(3), val];
		}
		return [key, val];
	}),
);

// ── 1. The pure core: selectRecipient ───────────────────────────────────

function makeContact(overrides: Partial<Doc<'contacts'>> = {}): Doc<'contacts'> {
	return {
		_id: 'contact_test' as Id<'contacts'>,
		_creationTime: Date.now(),
		email: 'person@example.com',
		firstName: 'Pat',
		lastName: 'Doe',
		timezone: 'UTC',
		language: 'en',
		source: 'api',
		doiStatus: 'confirmed',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as Doc<'contacts'>;
}

const noBlocks = { blockedEmails: new Set<string>() };

describe('selectRecipient — the eligibility predicate', () => {
	it('excludes a soft-deleted contact under either gate', () => {
		const c = makeContact({ deletedAt: Date.now() });
		expect(selectRecipient(c, { requiresDoi: true, ...noBlocks })).toBeNull();
		expect(selectRecipient(c, { requiresDoi: false, ...noBlocks })).toBeNull();
	});

	it('excludes an emailless contact', () => {
		const c = makeContact({ email: undefined });
		expect(selectRecipient(c, { requiresDoi: false, ...noBlocks })).toBeNull();
	});

	it('excludes a suppressed contact (case-insensitive match)', () => {
		const c = makeContact({ email: 'Blocked@Example.com' });
		const gate = { requiresDoi: false, blockedEmails: new Set(['blocked@example.com']) };
		expect(selectRecipient(c, gate)).toBeNull();
	});

	it('excludes a globally-unsubscribed contact under either gate', () => {
		// `contacts.unsubscribedAt` is the persistent marketing opt-out written
		// on a global unsubscribe; it gates BOTH paths so a matching segment can
		// never re-target them (CAN-SPAM/GDPR — PR-09).
		const c = makeContact({ unsubscribedAt: Date.now() });
		expect(selectRecipient(c, { requiresDoi: false, ...noBlocks })).toBeNull();
		expect(selectRecipient(c, { requiresDoi: true, ...noBlocks })).toBeNull();
	});

	it('excludes a DOI-pending contact when requiresDoi (topic path)', () => {
		const c = makeContact({ doiStatus: 'pending' });
		expect(selectRecipient(c, { requiresDoi: true, ...noBlocks })).toBeNull();
	});

	it('includes a DOI-pending contact when !requiresDoi (segment path — the named asymmetry)', () => {
		const c = makeContact({ doiStatus: 'pending', email: 'pending@x.com' });
		const r = selectRecipient(c, { requiresDoi: false, ...noBlocks });
		expect(r).not.toBeNull();
		expect(r!.email).toBe('pending@x.com');
	});

	it('excludes a form-forced-DOI membership still pending, even when !requiresDoi', () => {
		// The membership-level `pendingDoiConfirmation` flag gates independently of
		// the topic-level DOI flag: a form forced DOI on a non-DOI topic.
		const c = makeContact({ doiStatus: 'pending', email: 'pending@form.com' });
		expect(selectRecipient(c, { requiresDoi: false, ...noBlocks }, true)).toBeNull();
	});

	it('includes an eligible contact when the form-forced-DOI flag is absent/false', () => {
		const c = makeContact({ doiStatus: 'confirmed', email: 'ok@form.com' });
		expect(selectRecipient(c, { requiresDoi: false, ...noBlocks }, false)).not.toBeNull();
		expect(selectRecipient(c, { requiresDoi: false, ...noBlocks }, undefined)).not.toBeNull();
	});

	it('includes confirmed and not_required under a DOI-required gate', () => {
		for (const doiStatus of ['confirmed', 'not_required'] as const) {
			const c = makeContact({ doiStatus });
			expect(selectRecipient(c, { requiresDoi: true, ...noBlocks })).not.toBeNull();
		}
	});

	it('projects exactly the recipient fields', () => {
		const c = makeContact({
			_id: 'contact_x' as Id<'contacts'>,
			email: 'x@y.com',
			firstName: 'X',
			lastName: 'Y',
			timezone: 'Europe/Berlin',
			language: 'de',
		});
		expect(selectRecipient(c, { requiresDoi: false, ...noBlocks })).toEqual({
			_id: 'contact_x',
			email: 'x@y.com',
			firstName: 'X',
			lastName: 'Y',
			timezone: 'Europe/Berlin',
			language: 'de',
		});
	});
});

// ── 2-4. Integration: the two entries share one walk ─────────────────────

interface SeedResult {
	topicId: Id<'topics'>;
	segmentId: Id<'segments'>;
	aliceId: Id<'contacts'>;
	charlieId: Id<'contacts'>;
	eveId: Id<'contacts'>;
}

// Six contacts, all members of one DOI-required topic and all matching one
// "email contains match.com" segment:
//   alice   — confirmed, email           → eligible (both)
//   bob     — confirmed, email           → eligible (both)
//   charlie — pending,   email           → topic: excluded; segment: eligible
//   dave    — confirmed, NO email        → excluded (both)
//   eve     — confirmed, email, DELETED  → excluded (both)
//   frank   — confirmed, email, BLOCKED  → excluded (both)
async function seed(t: TestConvex<typeof schema>): Promise<SeedResult> {
	return await t.run(async (ctx) => {
		const topicId = await ctx.db.insert(
			'topics',
			createTestTopic({ requireDoubleOptIn: true }),
		);

		const mk = (o: Record<string, unknown>) =>
			ctx.db.insert('contacts', createTestContact(o));

		const aliceId = await mk({ email: 'alice@match.com', doiStatus: 'confirmed' });
		const bobId = await mk({ email: 'bob@match.com', doiStatus: 'confirmed' });
		const charlieId = await mk({ email: 'charlie@match.com', doiStatus: 'pending' });
		const daveId = await mk({ email: undefined, doiStatus: 'confirmed' });
		const eveId = await mk({
			email: 'eve@match.com',
			doiStatus: 'confirmed',
			deletedAt: Date.now(),
		});
		const frankId = await mk({ email: 'frank@match.com', doiStatus: 'confirmed' });

		for (const contactId of [aliceId, bobId, charlieId, daveId, eveId, frankId]) {
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
		}

		await ctx.db.insert(
			'blockedEmails',
			createTestBlockedEmail({ email: 'frank@match.com' }),
		);

		const segmentId = await ctx.db.insert('segments', {
			name: 'match.com folks',
			filters: {
				logic: 'AND',
				conditions: [
					{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'match.com' },
				],
			},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		return { topicId, segmentId, aliceId, charlieId, eveId };
	});
}

describe('Audience resolution — count and send share one predicate', () => {
	it('topic: eligible equals resolved length; gates DOI + emailless + suppressed + soft-deleted', async () => {
		const t = convexTest(schema, modules);
		const { topicId } = await seed(t);
		const audience = { kind: 'topic' as const, topicId };

		const resolved = await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
			audience,
		});
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, { audience });

		expect(resolved.map((r) => r.email).sort()).toEqual([
			'alice@match.com',
			'bob@match.com',
		]);
		expect(count.eligible).toBe(resolved.length); // anti-drift
		expect(count.total).toBe(6); // raw membership count
		expect(count.total - count.eligible).toBe(4); // honest excluded gap
	});

	it('segment: no DOI gate — includes DOI-pending; still gates emailless + suppressed + soft-deleted', async () => {
		const t = convexTest(schema, modules);
		const { segmentId } = await seed(t);
		const audience = { kind: 'segment' as const, segmentId };

		const resolved = await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
			audience,
		});
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, { audience });

		expect(resolved.map((r) => r.email).sort()).toEqual([
			'alice@match.com',
			'bob@match.com',
			'charlie@match.com',
		]);
		expect(count.eligible).toBe(resolved.length); // anti-drift
		// Live matches: alice, bob, charlie, frank (eve soft-deleted, dave emailless).
		expect(count.total).toBe(4);
	});

	it('soft-deleted contact appears in neither entry, for topic or segment', async () => {
		const t = convexTest(schema, modules);
		const { topicId, segmentId, eveId } = await seed(t);

		for (const audience of [
			{ kind: 'topic' as const, topicId },
			{ kind: 'segment' as const, segmentId },
		]) {
			const resolved = await t.query(
				internal.campaigns.audienceResolution.resolveRecipients,
				{ audience },
			);
			expect(resolved.map((r) => String(r._id))).not.toContain(String(eveId));
		}
	});

	it('topic: streams past the page boundary — resolves every eligible member of a large topic and still applies the filters on later pages', async () => {
		const t = convexTest(schema, modules);

		// TOPIC_PAGE_SIZE is 500; seed > 2 pages of members so the paginated
		// stream must continue past `isDone === false`. Two members on the LAST
		// page are deliberately ineligible (one soft-deleted, one DOI-pending
		// under a DOI-required topic) — proving `selectRecipient` still gates
		// rows that the streaming read surfaces only on a later page.
		const ELIGIBLE = 1100;
		const { topicId, eligibleEmails } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: true }),
			);

			const eligibleEmails: string[] = [];
			for (let i = 0; i < ELIGIBLE; i++) {
				const email = `member${i}@stream.test`;
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email, doiStatus: 'confirmed' }),
				);
				await ctx.db.insert('contactTopics', {
					contactId,
					topicId,
					addedAt: Date.now(),
				});
				eligibleEmails.push(email);
			}

			// Two ineligible members inserted LAST so they land on the final page.
			const deletedId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'gone@stream.test',
					doiStatus: 'confirmed',
					deletedAt: Date.now(),
				}),
			);
			const pendingId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'pending@stream.test', doiStatus: 'pending' }),
			);
			for (const contactId of [deletedId, pendingId]) {
				await ctx.db.insert('contactTopics', {
					contactId,
					topicId,
					addedAt: Date.now(),
				});
			}

			return { topicId, eligibleEmails };
		});

		const audience = { kind: 'topic' as const, topicId };
		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, {
			audience,
		});

		expect(resolved.length).toBe(ELIGIBLE); // every eligible member, across pages
		expect(new Set(resolved.map((r) => r.email))).toEqual(new Set(eligibleEmails));
		expect(resolved.map((r) => r.email)).not.toContain('gone@stream.test');
		expect(resolved.map((r) => r.email)).not.toContain('pending@stream.test');

		expect(count.eligible).toBe(resolved.length); // anti-drift, across pages
		expect(count.total).toBe(ELIGIBLE + 2); // raw membership count incl. the two excluded
	});

	it('segment: streams past the page boundary — resolves every matching live contact and still excludes soft-deleted/suppressed on later pages', async () => {
		const t = convexTest(schema, modules);

		// CONTACT_PAGE_SIZE is 500; seed > 2 pages of matching live contacts so
		// the paginated segment stream must continue past `isDone === false`. Two
		// matching-but-excluded contacts (one soft-deleted, one suppressed) are
		// inserted LAST so they land on the final page — proving the eligibility
		// gate still drops rows that the stream surfaces only on a later page.
		const ELIGIBLE = 1100;
		const { segmentId, eligibleEmails } = await t.run(async (ctx) => {
			const eligibleEmails: string[] = [];
			for (let i = 0; i < ELIGIBLE; i++) {
				const email = `member${i}@seg.test`;
				await ctx.db.insert('contacts', createTestContact({ email, doiStatus: 'pending' }));
				eligibleEmails.push(email);
			}

			// Two matching-but-ineligible contacts inserted LAST → final page.
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'gone@seg.test', deletedAt: Date.now() }),
			);
			await ctx.db.insert('contacts', createTestContact({ email: 'blocked@seg.test' }));
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@seg.test' }),
			);

			const segmentId = await ctx.db.insert('segments', {
				name: 'seg.test folks',
				filters: {
					logic: 'AND',
					conditions: [
						{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'seg.test' },
					],
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			return { segmentId, eligibleEmails };
		});

		const audience = { kind: 'segment' as const, segmentId };
		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, {
			audience,
		});

		// DOI-pending is eligible for a segment (the named asymmetry); the
		// soft-deleted contact never enters the live-only stream, the suppressed
		// one is dropped by selectRecipient.
		expect(resolved.length).toBe(ELIGIBLE);
		expect(new Set(resolved.map((r) => r.email))).toEqual(new Set(eligibleEmails));
		expect(resolved.map((r) => r.email)).not.toContain('gone@seg.test');
		expect(resolved.map((r) => r.email)).not.toContain('blocked@seg.test');

		expect(count.eligible).toBe(resolved.length); // anti-drift, across pages
		// total = raw segment matches over LIVE contacts: every eligible member
		// plus the suppressed one (live, matches); the soft-deleted one is not live.
		expect(count.total).toBe(ELIGIBLE + 1);
	});

	it('DOI-pending: excluded from a DOI-required topic, included in a matching segment', async () => {
		const t = convexTest(schema, modules);
		const { topicId, segmentId, charlieId } = await seed(t);

		const topicResolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience: { kind: 'topic', topicId } },
		);
		const segmentResolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience: { kind: 'segment', segmentId } },
		);

		expect(topicResolved.map((r) => String(r._id))).not.toContain(String(charlieId));
		expect(segmentResolved.map((r) => String(r._id))).toContain(String(charlieId));
	});

	it('form-forced DOI on a NON-DOI topic: an unconfirmed pending membership is excluded', async () => {
		// Regression (2026-07-03 review): a public form with its own "Enable
		// Double Opt-In" toggle inserts a `contactTopics` membership with
		// `pendingDoiConfirmation: true` on a topic that itself does NOT set
		// `requireDoubleOptIn`. Before the fix the send-time gate derived
		// `requiresDoi` solely from the topic flag (false here), so the pending
		// flag was never consulted and the still-unconfirmed contact was mailed —
		// the exact thing the form toggle exists to prevent.
		const t = convexTest(schema, modules);
		const { topicId, confirmedId, pendingFormId } = await t.run(async (ctx) => {
			// Topic does NOT require DOI at the topic level.
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);

			// Control: confirmed member, no form-DOI flag → eligible. `pending`
			// doiStatus here would normally be gated only by a DOI-required topic;
			// on this non-DOI topic it is NOT the contact-level gate that excludes.
			const confirmedId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'confirmed@form.test', doiStatus: 'confirmed' }),
			);
			// Form-forced DOI, still unconfirmed. Without the membership flag this
			// contact would pass the gate (topic requiresDoi === false).
			const pendingFormId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'pending@form.test', doiStatus: 'pending' }),
			);

			await ctx.db.insert('contactTopics', {
				contactId: confirmedId,
				topicId,
				addedAt: Date.now(),
			});
			await ctx.db.insert('contactTopics', {
				contactId: pendingFormId,
				topicId,
				addedAt: Date.now(),
				pendingDoiConfirmation: true,
			});

			return { topicId, confirmedId, pendingFormId };
		});

		const audience = { kind: 'topic' as const, topicId };
		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, {
			audience,
		});

		expect(resolved.map((r) => r.email)).toEqual(['confirmed@form.test']);
		expect(resolved.map((r) => String(r._id))).not.toContain(String(pendingFormId));
		expect(resolved.map((r) => String(r._id))).toContain(String(confirmedId));
		expect(count.eligible).toBe(resolved.length); // anti-drift
		expect(count.total).toBe(2); // both memberships are candidates
		expect(count.total - count.eligible).toBe(1); // the pending form membership is the excluded gap
	});
});

// ── 5. Per-page resolver: the checkpointed walker's hop ──────────────────
//
// resolveRecipientPage returns ONE page; looping it from cursor '' until
// nextCursor === null must reproduce resolveRecipients EXACTLY (same eligible
// rows, no dup, no drop), for both topic and segment, across >1 page.

async function drainPages(
	t: TestConvex<typeof schema>,
	audience: Doc<'campaigns'>['audience'] & object,
): Promise<{ emails: string[]; totalCandidates: number; pageCount: number }> {
	const emails: string[] = [];
	let totalCandidates = 0;
	let pageCount = 0;
	let cursor = '';
	for (;;) {
		const page = await t.query(
			internal.campaigns.audienceResolution.resolveRecipientPage,
			// Small numItems forces multiple pages so the resume logic is exercised.
			{ audience, cursor, numItems: 7 },
		);
		pageCount++;
		totalCandidates += page.pageCandidates;
		emails.push(...page.recipients.map((r) => r.email));
		if (page.nextCursor === null) break;
		cursor = page.nextCursor;
	}
	return { emails, totalCandidates, pageCount };
}

describe('resolveRecipientPage — per-page equivalence with resolveRecipients', () => {
	it('topic: looping the page resolver equals the whole-audience resolve (>1 page)', async () => {
		const t = convexTest(schema, modules);
		const { topicId } = await seed(t);
		const audience = { kind: 'topic' as const, topicId };

		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		const drained = await drainPages(t, audience);

		expect(drained.emails.sort()).toEqual(resolved.map((r) => r.email).sort());
		expect(drained.totalCandidates).toBe(6); // raw membership count across pages
		// No duplicate recipient across page boundaries.
		expect(new Set(drained.emails).size).toBe(drained.emails.length);
	});

	it('segment: looping the page resolver equals the whole-audience resolve (>1 page)', async () => {
		const t = convexTest(schema, modules);
		const { segmentId } = await seed(t);
		const audience = { kind: 'segment' as const, segmentId };

		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		const drained = await drainPages(t, audience);

		expect(drained.emails.sort()).toEqual(resolved.map((r) => r.email).sort());
		expect(new Set(drained.emails).size).toBe(drained.emails.length);
	});

	it('topic: equivalence holds across a real multi-page (>500) audience', async () => {
		const t = convexTest(schema, modules);
		const ELIGIBLE = 1100; // > 2 default pages of 500
		const { topicId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);
			for (let i = 0; i < ELIGIBLE; i++) {
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email: `pg${i}@page.test`, doiStatus: 'not_required' }),
				);
				await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
			}
			return { topicId };
		});

		const audience = { kind: 'topic' as const, topicId };
		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		const drained = await drainPages(t, audience);

		expect(resolved).toHaveLength(ELIGIBLE);
		expect(drained.pageCount).toBeGreaterThan(1);
		expect(new Set(drained.emails)).toEqual(new Set(resolved.map((r) => r.email)));
		expect(drained.emails.length).toBe(ELIGIBLE); // no dup, no drop
	});

	// ── PR-72 regression-lock: suppression excluded PER PAGE, case-insensitive ──
	//
	// On a single resolved page, a suppressed contact must still be COUNTED in
	// pageCandidates (it's a real membership/match — the "honest excluded gap"
	// denominator) but must NOT appear in recipients. The match is
	// case-insensitive: a contact whose stored email is mixed-case (Blocked@X)
	// is excluded by a lowercased blockedEmails row (blocked@x). This locks the
	// pageCandidates-counts-but-recipients-excludes contract directly on the
	// walker's hop. See EMAIL_BEST_PRACTICES_AUDIT_2026-06-21.md "PR-72".
	it('topic: a suppressed (mixed-case) member is counted in pageCandidates but excluded from recipients', async () => {
		const t = convexTest(schema, modules);
		const { topicId } = await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);
			const eligibleId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'ok@page.test', doiStatus: 'not_required' }),
			);
			// Stored email is mixed-case; the blocklist row is lowercased.
			const blockedId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'Blocked@Page.Test', doiStatus: 'not_required' }),
			);
			for (const contactId of [eligibleId, blockedId]) {
				await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
			}
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@page.test' }),
			);
			return { topicId };
		});

		const audience = { kind: 'topic' as const, topicId };
		// One generous page so both members land on the same page.
		const page = await t.query(
			internal.campaigns.audienceResolution.resolveRecipientPage,
			{ audience, cursor: '', numItems: 50 },
		);

		// Both memberships are counted as candidates...
		expect(page.pageCandidates).toBe(2);
		// ...but the suppressed (mixed-case) one is excluded from recipients.
		expect(page.recipients).toHaveLength(1);
		expect(page.recipients.map((r) => r.email)).toEqual(['ok@page.test']);
		expect(page.recipients.map((r) => r.email.toLowerCase())).not.toContain(
			'blocked@page.test',
		);
	});
});

// ── 6. Count cap — bounded wizard readout ────────────────────────────────

describe('countRecipients — capped at the ceiling', () => {
	it('an audience under the ceiling reports an exact, uncapped count', async () => {
		const t = convexTest(schema, modules);
		const { topicId } = await seed(t);
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, {
			audience: { kind: 'topic', topicId },
		});
		expect(count.capped).toBe(false);
		expect(count.total).toBe(6);
		expect(count.eligible).toBe(2);
	});

	it('an audience over the ceiling reports capped=true clamped to 25,000', async () => {
		const t = convexTest(schema, modules);
		// Seed > 25,000 matching live contacts so the stream hits COUNT_CEILING.
		const OVER = 25_010;
		const segmentId = await t.run(async (ctx) => {
			for (let i = 0; i < OVER; i++) {
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: `cap${i}@cap.test`, doiStatus: 'not_required' }),
				);
			}
			return await ctx.db.insert('segments', {
				name: 'cap.test folks',
				filters: {
					logic: 'AND',
					conditions: [
						{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'cap.test' },
					],
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const count = await t.query(api.campaigns.audienceResolution.countRecipients, {
			audience: { kind: 'segment', segmentId },
		});
		expect(count.capped).toBe(true);
		expect(count.total).toBe(25_000); // clamped to the ceiling
		expect(count.eligible).toBeLessThanOrEqual(25_000);
	});

	it('no audience yields zero, uncapped', async () => {
		const t = convexTest(schema, modules);
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, {
			audience: undefined,
		});
		expect(count).toEqual({ total: 0, eligible: 0, capped: false });
	});
});

// ── 7. Global unsubscribe honored across segment campaigns (PR-09) ─────────
//
// Unsubscribe used to be modeled ONLY as a contactTopics delete, but segment
// audiences select from the contacts table independent of topic membership —
// so a globally-unsubscribed Contact was still emailed by any matching segment
// campaign (CAN-SPAM/GDPR violation). The fix writes a persistent
// `contacts.unsubscribedAt` opt-out that `selectRecipient` consults on BOTH
// paths. These tests drive the real `unsubscribeAllForContact` entry (not a
// hand-set field) so they cover the end-to-end signal.

describe('Audience resolution — honors global unsubscribe across segments (PR-09)', () => {
	async function seedSubscribedPair(t: TestConvex<typeof schema>) {
		return await t.run(async (ctx) => {
			const topicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false }),
			);
			// Match-all segment (no conditions) so membership is irrelevant to
			// selection — both contacts match purely by existing.
			const segmentId = await ctx.db.insert('segments', {
				name: 'everyone',
				filters: { logic: 'AND', conditions: [] },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const unsubId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'unsub@pr09.test', doiStatus: 'not_required' }),
			);
			const keepId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'keep@pr09.test', doiStatus: 'not_required' }),
			);
			for (const contactId of [unsubId, keepId]) {
				await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
			}

			return { topicId, segmentId, unsubId, keepId };
		});
	}

	it('a globally-unsubscribed contact is excluded from a matching segment; a non-unsubscribed match is still returned', async () => {
		const t = convexTest(schema, modules);
		const { segmentId, unsubId, keepId } = await seedSubscribedPair(t);
		const audience = { kind: 'segment' as const, segmentId };

		// Before unsubscribe: both contacts resolve (segment ignores topic
		// membership — this is exactly why the global opt-out is needed).
		const before = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		expect(before.map((r) => r.email).sort()).toEqual([
			'keep@pr09.test',
			'unsub@pr09.test',
		]);

		// Global unsubscribe (no topicId) — the public unsubscribe link path.
		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId: unsubId,
			source: 'public_email_link',
			reason: 'unsubscribe',
		});

		// The persistent opt-out was written.
		const stamped = await t.run((ctx) => ctx.db.get(unsubId));
		expect(stamped?.unsubscribedAt).toBeTypeOf('number');

		// After unsubscribe: the unsubscribed contact is gone; the positive
		// control (keep@) is still returned.
		const after = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		expect(after.map((r) => r.email)).toEqual(['keep@pr09.test']);
		expect(after.map((r) => String(r._id))).not.toContain(String(unsubId));
		expect(after.map((r) => String(r._id))).toContain(String(keepId));

		// countRecipients shares the predicate, so its eligible count drops too.
		const count = await t.query(api.campaigns.audienceResolution.countRecipients, {
			audience,
		});
		expect(count.eligible).toBe(1);
	});

	it('global unsubscribe also suppresses the contact in a topic audience', async () => {
		const t = convexTest(schema, modules);
		const { topicId, unsubId, keepId } = await seedSubscribedPair(t);

		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId: unsubId,
			source: 'public_email_link',
			reason: 'unsubscribe',
		});

		// The topic membership for unsub@ was deleted by the same call, but even
		// a contact who somehow retained a membership must be excluded by the
		// opt-out — keep@ (still a member, not unsubscribed) is the control.
		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience: { kind: 'topic', topicId } },
		);
		expect(resolved.map((r) => r.email)).toEqual(['keep@pr09.test']);
		expect(resolved.map((r) => String(r._id))).not.toContain(String(unsubId));
		expect(resolved.map((r) => String(r._id))).toContain(String(keepId));
	});

	it('re-subscribing to any topic lifts the global opt-out and makes the contact reachable again', async () => {
		const t = convexTest(schema, modules);
		const { topicId, segmentId, unsubId } = await seedSubscribedPair(t);
		const audience = { kind: 'segment' as const, segmentId };

		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId: unsubId,
			source: 'public_email_link',
			reason: 'unsubscribe',
		});
		const afterUnsub = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		expect(afterUnsub.map((r) => r.email)).not.toContain('unsub@pr09.test');

		// Active opt-in via a topic resubscribe clears unsubscribedAt.
		await t.mutation(internal.topics.subscription.subscribe, {
			topicId,
			contactId: unsubId,
			source: 'preferences_page',
			skipDoi: true,
		});
		const cleared = await t.run((ctx) => ctx.db.get(unsubId));
		expect(cleared?.unsubscribedAt).toBeUndefined();

		const afterResub = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		expect(afterResub.map((r) => r.email)).toContain('unsub@pr09.test');
	});

	it('single-topic unsubscribe (topicId present) does NOT set the global opt-out', async () => {
		const t = convexTest(schema, modules);
		const { topicId, segmentId, unsubId } = await seedSubscribedPair(t);
		const audience = { kind: 'segment' as const, segmentId };

		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId: unsubId,
			topicId,
			source: 'public_email_link',
			reason: 'unsubscribe',
		});

		const contact = await t.run((ctx) => ctx.db.get(unsubId));
		expect(contact?.unsubscribedAt).toBeUndefined();

		// Still reachable by a matching segment — a single-topic opt-out is not
		// a global marketing opt-out.
		const resolved = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience },
		);
		expect(resolved.map((r) => r.email)).toContain('unsub@pr09.test');
	});

	it('a DOI-pending re-subscribe (no skipDoi) does NOT lift the opt-out until DOI is confirmed', async () => {
		// Compliance regression: a public form (unauthenticated, any email)
		// bound to a DOI topic must not silently lift a persistent global
		// opt-out. The opt-out is only lifted by a CONFIRMED opt-in, so a
		// globally-unsubscribed contact stays excluded from a matching segment
		// while the re-subscribe is still DOI-pending, then becomes reachable
		// once the confirmation token is consumed.
		const t = convexTest(schema, modules);
		const { segmentId, unsubId } = await seedSubscribedPair(t);
		const audience = { kind: 'segment' as const, segmentId };

		// A DOI-required topic (the public-form target).
		const doiTopicId = await t.run((ctx) =>
			ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true })),
		);

		// Global unsubscribe — sets the persistent opt-out and deletes prior
		// memberships.
		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId: unsubId,
			source: 'public_email_link',
			reason: 'unsubscribe',
		});
		expect((await t.run((ctx) => ctx.db.get(unsubId)))?.unsubscribedAt).toBeTypeOf(
			'number',
		);
		expect(
			(
				await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
					audience,
				})
			).map((r) => r.email),
		).not.toContain('unsub@pr09.test');

		// Form re-subscribe to the DOI topic — DOI required, NOT skipped. This
		// is the third-party-triggerable path; it must NOT lift the opt-out.
		const result = await t.mutation(internal.topics.subscription.subscribe, {
			topicId: doiTopicId,
			contactId: unsubId,
			source: 'form',
			siteUrl: 'https://example.test',
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.action).toBe('pending_doi');

		// Opt-out still set; contact still excluded from the segment.
		const pending = await t.run((ctx) => ctx.db.get(unsubId));
		expect(pending?.unsubscribedAt).toBeTypeOf('number');
		expect(pending?.doiStatus).toBe('pending');
		expect(
			(
				await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
					audience,
				})
			).map((r) => r.email),
		).not.toContain('unsub@pr09.test');

		// Confirm DOI by consuming the token — a genuine completed opt-in.
		const token =
			result.ok && result.action === 'pending_doi' ? result.doiToken : '';
		expect(token).not.toBe('');
		await t.mutation(
			internal.contacts.doiLifecycle.transitionByConfirmationToken,
			{ token, input: { to: 'confirmed', at: Date.now() } },
		);

		// Now the opt-out is lifted and the contact is reachable again.
		const confirmed = await t.run((ctx) => ctx.db.get(unsubId));
		expect(confirmed?.doiStatus).toBe('confirmed');
		expect(confirmed?.unsubscribedAt).toBeUndefined();
		expect(
			(
				await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
					audience,
				})
			).map((r) => r.email),
		).toContain('unsub@pr09.test');
	});
});
