/**
 * Integration tests for the Transactional send intake (module).
 *
 * Per-reason rejection coverage + happy-path assertions on the row write,
 * counter increments, and language persistence. The workpool is excluded
 * from the module loader so `enqueueAction` becomes a no-op — the test
 * checks pre-enqueue state only.
 *
 * See docs/adr/0021-transactional-send-intake-module.md.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { transactionalEmailPool } from '../delivery/workpool';
import { normalizeEmail } from '../lib/inputGuards';
import {
	createTestBlockedEmail,
	createTestDomain,
	createTestInstanceSettings,
	createTestTransactionalEmail,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

// Stub the workpool so dispatch's `enqueueAction` is a no-op (the Workpool
// component isn't registered in convexTest, and the worker action would
// need provider credentials we don't seed). We assert pre-enqueue state.
vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
	campaignEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
}));

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool'),
	),
);

// Silence "Could not find module" rejections from the excluded workpool/worker
// modules — the dispatch enqueues an action whose target module is filtered
// out of this test harness. The dispatch itself completes; the scheduled task
// merely can't find its target.
const suppressed: Error[] = [];
const onRejection = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressed.push(err);
	} else {
		throw err;
	}
};
beforeEach(() => {
	suppressed.length = 0;
	process.on('unhandledRejection', onRejection);
});
afterEach(() => {
	process.removeListener('unhandledRejection', onRejection);
});

// ─── Seed helpers ───────────────────────────────────────────────────────────

async function seedBaseline(
	t: TestConvex<typeof schema>,
	overrides: {
		abuseStatus?: 'clean' | 'warned' | 'suspended' | 'banned';
		domainStatus?: 'verified' | 'pending' | 'failed' | 'registering';
		templateStatus?: 'draft' | 'published' | 'pending_review';
		htmlContent?: string;
		dataVariablesSchema?: Record<string, 'string' | 'number' | 'boolean' | 'date'>;
		htmlTranslations?: string;
		supportedLanguages?: string[];
		defaultLanguage?: string;
	} = {},
): Promise<{
	templateId: Id<'transactionalEmails'>;
	slug: string;
	domainId: Id<'domains'>;
	settingsId: Id<'instanceSettings'>;
}> {
	return await t.run(async (ctx) => {
		const settingsId = await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				abuseStatus: overrides.abuseStatus ?? 'clean',
				defaultFromEmail: 'noreply@example.com',
				defaultFromName: 'Owlat',
				transactionalSendCount: 0,
				dailySendCount: 0,
			}),
		);
		const domainId = await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'example.com',
				status: overrides.domainStatus ?? 'verified',
				lastVerifiedAt: Date.now(),
			}),
		);
		const tpl = createTestTransactionalEmail({
			status: overrides.templateStatus ?? 'published',
			htmlContent:
				overrides.htmlContent ?? '<p>Hello {{firstName}}</p>',
			subject: 'Welcome',
			dataVariablesSchema: overrides.dataVariablesSchema,
			htmlTranslations: overrides.htmlTranslations,
			supportedLanguages: overrides.supportedLanguages ?? ['en'],
			defaultLanguage: overrides.defaultLanguage ?? 'en',
		});
		const templateId = await ctx.db.insert('transactionalEmails', tpl);
		return {
			templateId,
			slug: tpl.slug as string,
			domainId,
			settingsId,
		};
	});
}

// ─── Happy path ─────────────────────────────────────────────────────────────

describe('transactional.dispatch.dispatch — happy path', () => {
	it('inserts a queued row, increments both counters, and returns ok', async () => {
		const t = convexTest(schema, modules);
		const { templateId, settingsId } = await seedBaseline(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(outcome.queued).toBe(true);
		expect(outcome.language).toBe('en');
		expect(outcome.contactCreated).toBe(true);

		// Row exists, is queued, carries language.
		const send = await t.run(async (ctx) => await ctx.db.get(outcome.sendId));
		expect(send?.status).toBe('queued');
		expect(send?.language).toBe('en');
		expect(send?.email).toBe('recipient@example.com');
		expect(send?.contactId).toBe(outcome.contactId);

		// Both counters incremented atomically.
		const settings = await t.run(async (ctx) => await ctx.db.get(settingsId));
		expect(settings?.transactionalSendCount).toBe(1);
		expect(settings?.dailySendCount).toBe(1);
	});

	it('resolves an existing contact via Contact resolution (upsert mode)', async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t);

		// Pre-seed the contact + its identity row (mirrors what resolveContact would do).
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', {
				email: 'returning@example.com',
				firstName: 'Returning',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contactIdentities', {
				contactId: id,
				channel: 'email' as const,
				identifier: 'returning@example.com',
				isPrimary: true,
				createdAt: Date.now(),
			});
			return id;
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'returning@example.com',
		});

		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(outcome.contactCreated).toBe(false);
		expect(outcome.contactId).toBe(contactId);
	});

	it('looks up a template by slug as well as by id', async () => {
		const t = convexTest(schema, modules);
		const { slug } = await seedBaseline(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'slug', slug },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(true);
	});

	it('falls back to contact language when no request language', async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, {
			supportedLanguages: ['en', 'de'],
			htmlTranslations: JSON.stringify({
				de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' },
			}),
		});

		// Contact already exists with German preference.
		await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', {
				email: 'german@example.com',
				firstName: 'Hans',
				source: 'api' as const,
				language: 'de',
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contactIdentities', {
				contactId: id,
				channel: 'email' as const,
				identifier: 'german@example.com',
				isPrimary: true,
				createdAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'german@example.com',
		});

		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(outcome.language).toBe('de');

		const send = await t.run(async (ctx) => await ctx.db.get(outcome.sendId));
		expect(send?.language).toBe('de');
	});
});

// ─── Per-reason rejection coverage ──────────────────────────────────────────

describe('transactional.dispatch.dispatch — rejections', () => {
	it("returns 'abuse_blocked' when instance is suspended", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, { abuseStatus: 'suspended' });

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('abuse_blocked');
	});

	it("returns 'no_delivery_provider' and writes no row when no provider is configured", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t);
		const saved = {
			p: process.env['EMAIL_PROVIDER'],
			u: process.env['MTA_API_URL'],
			k: process.env['MTA_API_KEY'],
		};
		delete process.env['EMAIL_PROVIDER'];
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];
		try {
			const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
				templateLookup: { kind: 'id', id: templateId },
				email: 'recipient@example.com',
			});

			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error('expected rejection');
			expect(outcome.reason).toBe('no_delivery_provider');

			// Intake rejected before any row write — nothing queued.
			const rows = await t.run(async (ctx) => await ctx.db.query('transactionalSends').collect());
			expect(rows.length).toBe(0);
		} finally {
			if (saved.p !== undefined) process.env['EMAIL_PROVIDER'] = saved.p;
			if (saved.u !== undefined) process.env['MTA_API_URL'] = saved.u;
			if (saved.k !== undefined) process.env['MTA_API_KEY'] = saved.k;
		}
	});

	it("returns 'recipient_blocked' when the recipient is on the blocklist", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com' }),
			);
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'blocked@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('recipient_blocked');
	});

	// ── PR-72 regression-lock: a blocked recipient produces NO side effects ──
	//
	// The earlier test only asserts the outcome reason. The enforcement value of
	// the blocklist is the absence of side effects: the dispatch must reject
	// BEFORE inserting a transactionalSends row, BEFORE bumping any counter, and
	// BEFORE enqueuing the worker action — otherwise a blocked address still gets
	// mailed / still drags the daily counter. See
	// EMAIL_BEST_PRACTICES_AUDIT_2026-06-21.md "PR-72".
	it('a blocked recipient writes no send row, bumps no counter, and enqueues nothing', async () => {
		const t = convexTest(schema, modules);
		const { templateId, settingsId } = await seedBaseline(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com' }),
			);
		});

		const enqueue = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueue.mockClear();

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'blocked@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('recipient_blocked');

		// No transactionalSends row was created.
		const sends = await t.run(async (ctx) =>
			ctx.db.query('transactionalSends').collect(),
		);
		expect(sends).toHaveLength(0);

		// Counters untouched (the daily/transactional counters fire only after the
		// blocklist gate passes).
		const settings = await t.run(async (ctx) => ctx.db.get(settingsId));
		expect(settings?.transactionalSendCount ?? 0).toBe(0);
		expect(settings?.dailySendCount ?? 0).toBe(0);

		// No worker enqueue.
		expect(enqueue).not.toHaveBeenCalled();
	});

	// The blocklist match is case-insensitive end to end: the HTTP shell
	// lowercases the input (USER@ → user@) and the stored blockedEmails row is
	// normalized, so a mixed-case request to a blocked address is still rejected.
	// dispatch trusts the shell's normalization, so this drives the already-
	// normalized (lowercased) email against a normalized row — the contract the
	// HTTP shell guarantees.
	it('rejects a normalized (lowercased) request against a blocked address (USER@ vs user@)', async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t);
		await t.run(async (ctx) => {
			// Stored normalized, exactly as the lifecycle / blocklist writer stores it.
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'mixed@example.com' }),
			);
		});

		// The HTTP shell sends `normalizeEmail('Mixed@Example.com')` === 'mixed@example.com'.
		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: normalizeEmail('Mixed@Example.com'),
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('recipient_blocked');
	});

	it("returns 'template_not_found' when slug doesn't exist", async () => {
		const t = convexTest(schema, modules);
		await seedBaseline(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'slug', slug: 'no-such-slug' },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('template_not_found');
	});

	it("returns 'template_not_published' when status is 'draft'", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, { templateStatus: 'draft' });

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('template_not_published');
	});

	it("returns 'template_no_content' when htmlContent is empty", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, { htmlContent: '' });

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('template_no_content');
	});

	it("returns 'domain_unverified' when domain status is not 'verified'", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, { domainStatus: 'pending' });

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('domain_unverified');
	});

	it("returns 'invalid_variables' when dataVariables don't match the template schema", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, {
			dataVariablesSchema: { age: 'number' },
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
			dataVariables: { age: 'not-a-number' },
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('invalid_variables');
	});
});

// ─── Drift-bug closures ─────────────────────────────────────────────────────

describe('transactional.dispatch.dispatch — drift-bug closures', () => {
	it("created contacts carry source 'transactional' (Contact resolution wiring)", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'newbie@example.com',
		});

		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);

		const contact = await t.run(async (ctx) => await ctx.db.get(outcome.contactId));
		expect(contact?.source).toBe('transactional');
	});

	it('persists resolved language on the transactionalSends row (analytics drift fix)', async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, {
			supportedLanguages: ['en', 'de'],
			htmlTranslations: JSON.stringify({
				de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' },
			}),
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
			language: 'de',
		});

		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		const send = await t.run(async (ctx) => await ctx.db.get(outcome.sendId));
		expect(send?.language).toBe('de');
	});
});
