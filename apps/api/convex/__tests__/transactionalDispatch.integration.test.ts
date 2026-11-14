/**
 * Integration tests for the Transactional send intake (module).
 *
 * Per-reason rejection coverage + happy-path assertions on the row write,
 * counter increments, and language persistence. The workpool is excluded
 * from the module loader so `enqueueAction` becomes a no-op — the test
 * checks pre-enqueue state only.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { transactionalEmailPool } from '../delivery/workpool';
import { normalizeEmail } from '../lib/inputGuards';
import {
	createTestApiKey,
	createTestBlockedEmail,
	createTestContact,
	createTestDomain,
	createTestInstanceSettings,
	createTestTransactionalEmail,
} from './factories';
import { readInstanceCounter } from '../lib/instanceCounters';
import { mtaSendProvider } from '../lib/sendProviders/mta';
import { resolveSendTransport } from '../lib/sendProviders/transports';
import { getMutationContext, getSingletonOrganizationId } from '../lib/sessionOrganization';
import type * as SessionOrganization from '../lib/sessionOrganization';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		// Pass-through by default; the routing-hold tests name the organization
		// whose deliverability state the route resolution reads.
		getSingletonOrganizationId: vi.fn(
			actual.getSingletonOrganizationId as (ctx: unknown) => Promise<string>
		),
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
			!path.includes('delivery/workpool')
	)
);

/** A harness with the rate-limiter component the intake's send caps charge. */
function newTest(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

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
	} = {}
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
			})
		);
		const domainId = await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'example.com',
				status: overrides.domainStatus ?? 'verified',
				lastVerifiedAt: Date.now(),
			})
		);
		const tpl = createTestTransactionalEmail({
			status: overrides.templateStatus ?? 'published',
			// A fallback, so a request that sends no variables is still complete.
			htmlContent: overrides.htmlContent ?? "<p>Hello {{firstName|'there'}}</p>",
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
		const t = newTest();
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

		// Both counters incremented atomically, on the `sends` counter row; the
		// settings singleton every feature gate reads is left alone (plan 2.4).
		const sends = await t.run(async (ctx) => await readInstanceCounter(ctx.db, 'sends'));
		expect(sends.transactionalSendCount).toBe(1);
		expect(sends.dailySendCount).toBe(1);
		const settings = await t.run(async (ctx) => await ctx.db.get(settingsId));
		expect(settings?.transactionalSendCount).toBe(0);
		expect(settings?.dailySendCount).toBe(0);
	});

	it('stores the correlation id on the Send row and keeps it out of the queued envelope', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		const enqueue = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueue.mockClear();

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		const send = await t.run(async (ctx) => await ctx.db.get(outcome.sendId));
		expect(send?.correlationId).toMatch(/^txn_/);
		// The queued envelope is the routing re-entry token's digest material, so a
		// log-only id stays on the row and the dispatch boundary reads it there.
		expect(enqueue).toHaveBeenCalledOnce();
		const queued = enqueue.mock.calls[0]?.[2] as { envelopeInput: Record<string, unknown> };
		expect(queued.envelopeInput['sendId']).toBe(outcome.sendId);
		expect('correlationId' in queued.envelopeInput).toBe(false);
		expect(JSON.stringify(queued)).not.toContain(send!.correlationId!);
	});

	it('resolves an existing contact via Contact resolution (upsert mode)', async () => {
		const t = newTest();
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
		const t = newTest();
		const { slug } = await seedBaseline(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'slug', slug },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(true);
	});

	it('answers with the template slug when the request names the template by id', async () => {
		const t = newTest();
		const { templateId, slug } = await seedBaseline(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		expect(outcome).toMatchObject({ ok: true, slug });
	});

	it('falls back to contact language when no request language', async () => {
		const t = newTest();
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
	it("returns 'feature_disabled' and writes no row while the transactional feature is off", async () => {
		const t = newTest();
		const { templateId, settingsId } = await seedBaseline(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(settingsId, { featureFlags: { transactional: false } });
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('feature_disabled');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('transactionalSends').collect()).toHaveLength(0);
		});
	});

	it("returns 'abuse_blocked' when instance is suspended", async () => {
		const t = newTest();
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
		const t = newTest();
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
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com' })
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
		const t = newTest();
		const { templateId, settingsId } = await seedBaseline(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com' })
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
		const sends = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
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
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		await t.run(async (ctx) => {
			// Stored normalized, exactly as the lifecycle / blocklist writer stores it.
			await ctx.db.insert('blockedEmails', createTestBlockedEmail({ email: 'mixed@example.com' }));
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
		const t = newTest();
		await seedBaseline(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'slug', slug: 'no-such-slug' },
			email: 'recipient@example.com',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('template_not_found');
	});

	it.each([
		['a malformed id', 'not-a-template-id'],
		['an id from another table', 'contact'],
	])("returns 'template_not_found' for %s", async (_label, kind) => {
		const t = newTest();
		await seedBaseline(t);
		const id =
			kind === 'contact'
				? await t.run(async (ctx) => await ctx.db.insert('contacts', createTestContact()))
				: kind;

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id },
			email: 'recipient@example.com',
		});

		expect(outcome).toMatchObject({ ok: false, reason: 'template_not_found' });
	});

	it("returns 'template_not_published' when status is 'draft'", async () => {
		const t = newTest();
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
		const t = newTest();
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
		const t = newTest();
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
		const t = newTest();
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

	it("returns 'invalid_variables' naming a variable the email uses without a fallback", async () => {
		const t = convexTest(schema, modules);
		const { templateId } = await seedBaseline(t, {
			htmlContent: "<p>Hi {{firstName|'there'}}, reset here: {{resetUrl}}</p>",
			dataVariablesSchema: { firstName: 'string', resetUrl: 'string' },
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
			dataVariables: { resetURL: 'https://example.com/reset?token=t' },
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('expected rejection');
		expect(outcome.reason).toBe('invalid_variables');
		expect(outcome.detail).toContain('"resetUrl"');
		expect(outcome.detail).not.toContain('firstName');
		expect(await t.run((ctx) => ctx.db.query('contacts').collect())).toHaveLength(0);
	});
});

// ─── Drift-bug closures ─────────────────────────────────────────────────────

describe('transactional.dispatch.dispatch — drift-bug closures', () => {
	it("created contacts carry source 'transactional' (Contact resolution wiring)", async () => {
		const t = newTest();
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
		const t = newTest();
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

// ─── The queued envelope and the receipt replay ─────────────────────────────
// What one intake hands the worker and writes beside the row, pinned before
// the intake's decisions moved into `transactional/dispatchDecision.ts`.

describe('transactional.dispatch.dispatch — queued envelope', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function queuedEnvelope(): Promise<Record<string, unknown>> {
		const enqueue = vi.mocked(transactionalEmailPool.enqueueAction);
		expect(enqueue).toHaveBeenCalledOnce();
		const queued = enqueue.mock.calls[0]?.[2] as
			| { envelopeInput: Record<string, unknown> }
			| undefined;
		if (!queued) throw new Error('expected one queued envelope');
		return queued.envelopeInput;
	}

	it('queues the default language with its plain text and the unsubscribe footer', async () => {
		vi.stubEnv('SITE_URL', 'https://app.owlat.example');
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		await t.run(async (ctx) =>
			ctx.db.patch(templateId, {
				plainTextContent: 'Hello in text',
				showUnsubscribe: true,
				sendCount: 4,
			})
		);
		vi.mocked(transactionalEmailPool.enqueueAction).mockClear();

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
			dataVariables: { firstName: 'Ada' },
		});
		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);

		const template = await t.run(async (ctx) => await ctx.db.get(templateId));
		expect(template?.sendCount).toBe(5);
		const envelope = await queuedEnvelope();
		expect(envelope).toMatchObject({
			kind: 'transactional',
			emailPurpose: 'transactional',
			to: 'recipient@example.com',
			from: 'Owlat <noreply@example.com>',
			sendId: outcome.sendId,
			template: {
				subject: 'Welcome',
				htmlContent: "<p>Hello {{firstName|'there'}}</p>",
				plainTextContent: 'Hello in text',
			},
			dataVariables: { firstName: 'Ada' },
			showUnsubscribe: true,
			contactId: outcome.contactId,
			siteUrl: 'https://app.owlat.example',
		});
	});

	it('queues a translation without the default language plain text and no footer', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t, {
			supportedLanguages: ['en', 'de'],
			htmlTranslations: JSON.stringify({
				de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' },
			}),
		});
		await t.run(async (ctx) => ctx.db.patch(templateId, { plainTextContent: 'Hello in text' }));
		vi.mocked(transactionalEmailPool.enqueueAction).mockClear();

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
			language: 'de',
		});
		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(outcome.language).toBe('de');

		const envelope = await queuedEnvelope();
		expect(envelope['template']).toEqual({ subject: 'Hallo', htmlContent: '<p>Hallo</p>' });
		expect('showUnsubscribe' in envelope).toBe(false);
		expect('contactId' in envelope).toBe(false);
	});

	it('answers a repeat of a committed request from its receipt and queues nothing more', async () => {
		const t = newTest();
		const { templateId, slug } = await seedBaseline(t);
		const idempotency = { organizationId: 'org_1', keyHash: 'key-hash', requestHash: 'req-hash' };
		const request = {
			templateLookup: { kind: 'id' as const, id: templateId },
			email: 'recipient@example.com',
			idempotency,
		};
		vi.mocked(transactionalEmailPool.enqueueAction).mockClear();

		const first = await t.mutation(internal.transactional.dispatch.dispatch, request);
		const repeat = await t.mutation(internal.transactional.dispatch.dispatch, request);
		if (!first.ok || !repeat.ok) throw new Error('expected both outcomes ok');
		expect(repeat).toEqual({
			ok: true,
			sendId: first.sendId,
			contactId: first.contactId,
			contactCreated: true,
			language: 'en',
			slug,
			queued: true,
			replayed: true,
		});
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).toHaveBeenCalledOnce();
		const rows = await t.run(async (ctx) => await ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(1);
		const sends = await t.run(async (ctx) => await readInstanceCounter(ctx.db, 'sends'));
		expect(sends.transactionalSendCount).toBe(1);
	});
});

// ─── The sender ─────────────────────────────────────────────────────────────
// Template sender, then the transactional sender, then the default sender.
// Whatever resolves is the address the domain gate checks, the envelope's From
// (which the MTA signs as, `lib/sendProviders/mta`), and the address the Send
// row books reputation against.

describe('transactional.dispatch.dispatch — the sender', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function dispatchOnce(t: TestConvex<typeof schema>, templateId: Id<'transactionalEmails'>) {
		vi.mocked(transactionalEmailPool.enqueueAction).mockClear();
		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
		});
		const queued = vi.mocked(transactionalEmailPool.enqueueAction).mock.calls[0]?.[2] as
			| { envelopeInput: { from: string } }
			| undefined;
		return { outcome, from: queued?.envelopeInput.from };
	}

	async function verifyDomain(t: TestConvex<typeof schema>, domain: string, status = 'verified') {
		await t.run(async (ctx) =>
			ctx.db.insert(
				'domains',
				createTestDomain({
					domain,
					status: status as 'verified',
					lastVerifiedAt: Date.now(),
				})
			)
		);
	}

	it('sends from the default sender while no transactional sender is set', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		const { outcome, from } = await dispatchOnce(t, templateId);
		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(from).toBe('Owlat <noreply@example.com>');
	});

	it('sends from the transactional sender, signed as its own subdomain', async () => {
		const t = newTest();
		const { templateId, settingsId } = await seedBaseline(t);
		await verifyDomain(t, 'mail.example.com');
		await t.run(async (ctx) =>
			ctx.db.patch(settingsId, {
				transactionalFromEmail: 'account@mail.example.com',
				transactionalFromName: 'Example Accounts',
			})
		);

		const { outcome, from } = await dispatchOnce(t, templateId);
		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(from).toBe('Example Accounts <account@mail.example.com>');
		const send = await t.run(async (ctx) => await ctx.db.get(outcome.sendId));
		expect(send?.fromEmail).toBe('account@mail.example.com');

		// The MTA derives the DKIM `d=` from the From it is handed.
		vi.stubEnv('MTA_API_URL', 'http://mta.test');
		vi.stubEnv('MTA_API_KEY', 'test-key');
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ success: true, id: 'm' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);
		await mtaSendProvider.sendEmail(resolveSendTransport('mta'), {
			to: 'recipient@example.com',
			from: from!,
			subject: 'Welcome',
			html: '<p>Hello</p>',
		});
		const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
		expect(body.dkimDomain).toBe('mail.example.com');
		vi.unstubAllGlobals();
	});

	it("sends from the template's own sender ahead of the transactional sender", async () => {
		const t = newTest();
		const { templateId, settingsId } = await seedBaseline(t);
		await verifyDomain(t, 'mail.example.com');
		await t.run(async (ctx) => {
			await ctx.db.patch(settingsId, { transactionalFromEmail: 'account@mail.example.com' });
			await ctx.db.patch(templateId, {
				fromEmail: 'receipts@mail.example.com',
				fromName: 'Example Billing',
			});
		});

		const { outcome, from } = await dispatchOnce(t, templateId);
		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(from).toBe('Example Billing <receipts@mail.example.com>');
	});

	it('never sends from a resolved sender whose domain is not verified, and names that address', async () => {
		const t = newTest();
		const { templateId, settingsId } = await seedBaseline(t);
		// The default sender's domain is verified; the transactional sender's is not
		// (any more): the send is refused rather than quietly falling back.
		await verifyDomain(t, 'mail.example.com', 'pending');
		await t.run(async (ctx) =>
			ctx.db.patch(settingsId, { transactionalFromEmail: 'account@mail.example.com' })
		);

		const { outcome, from } = await dispatchOnce(t, templateId);
		if (outcome.ok) throw new Error('expected a refusal');
		expect(outcome.reason).toBe('domain_unverified');
		expect(outcome.detail).toContain('account@mail.example.com');
		expect(from).toBeUndefined();
		const rows = await t.run(async (ctx) => await ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);
	});
});

// ─── Temporary routing holds ────────────────────────────────────────────────
// An open org-wide safety circuit is "not right now": the worker holds and
// re-enters a queued send until the circuit closes. Intake must accept the
// request instead of throwing (which the HTTP shell answers with a 500).

describe('transactional.dispatch.dispatch — temporary routing holds', () => {
	const ORG = 'org-hold';

	beforeEach(() => {
		vi.mocked(getSingletonOrganizationId).mockResolvedValue(ORG);
		vi.mocked(transactionalEmailPool.enqueueAction).mockClear();
	});
	afterEach(async () => {
		const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
		vi.mocked(getSingletonOrganizationId).mockReset();
		vi.mocked(getSingletonOrganizationId).mockImplementation(actual.getSingletonOrganizationId);
		vi.unstubAllEnvs();
	});

	async function openGlobalBreaker(t: TestConvex<typeof schema>): Promise<void> {
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'all',
				isFallbackActive: true,
				signals: [{ source: 'breaker_open', severity: 'critical', observedAt: now }],
				fallbackActiveSince: now,
				snapshotGeneratedAt: now,
				expiresAt: now + 86_400_000,
				updatedAt: now,
			});
		});
	}

	it('accepts and queues the send while the org-wide delivery circuit is open', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		await openGlobalBreaker(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'reset@example.com',
		});

		if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
		expect(outcome.queued).toBe(true);
		const send = await t.run(async (ctx) => await ctx.db.get(outcome.sendId));
		expect(send?.status).toBe('queued');
		// No route was resolved, so the row names no provider: the worker resolves
		// one when the hold lifts, and the lifecycle stamps the one it used.
		expect(send?.providerType).toBeUndefined();
		const enqueue = vi.mocked(transactionalEmailPool.enqueueAction);
		expect(enqueue).toHaveBeenCalledOnce();
		const queued = enqueue.mock.calls[0]?.[2] as { envelopeInput: Record<string, unknown> };
		expect(queued.envelopeInput['sendId']).toBe(outcome.sendId);
		expect('providerType' in queued.envelopeInput).toBe(false);
		expect('ipPool' in queued.envelopeInput).toBe(false);
	});

	it("still refuses with 'no_delivery_provider' while the circuit is open and nothing can deliver", async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		await openGlobalBreaker(t);
		vi.stubEnv('EMAIL_PROVIDER', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'reset@example.com',
		});

		expect(outcome).toMatchObject({ ok: false, reason: 'no_delivery_provider' });
		const rows = await t.run(async (ctx) => await ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);
	});

	it("still refuses with 'domain_unverified' while the circuit is open", async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t, { domainStatus: 'pending' });
		await openGlobalBreaker(t);

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'reset@example.com',
		});

		expect(outcome).toMatchObject({ ok: false, reason: 'domain_unverified' });
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).not.toHaveBeenCalled();
	});
});

// ─── Configurable send caps and optional variables ──────────────────────────

describe('transactional.dispatch.dispatch — send caps an admin configures', () => {
	const HOUR = 60 * 60 * 1000;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const saveCaps = (
		t: TestConvex<typeof schema>,
		caps: {
			perRecipient?: { isEnabled: boolean; count: number; windowMs: number };
			perApiKeyDaily?: { isEnabled: boolean; count: number };
		}
	) =>
		t.mutation(api.transactional.sendCapSettings.update, {
			perRecipient: caps.perRecipient ?? { isEnabled: true, count: 5, windowMs: HOUR },
			perApiKeyDaily: caps.perApiKeyDaily ?? { isEnabled: true, count: 50_000 },
		});

	const seedKey = (t: TestConvex<typeof schema>) =>
		t.run((ctx) => ctx.db.insert('apiKeys', createTestApiKey()));

	const send = (
		t: TestConvex<typeof schema>,
		templateId: Id<'transactionalEmails'>,
		email: string,
		apiKeyId?: Id<'apiKeys'>
	) =>
		t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email,
			...(apiKeyId ? { apiKeyId } : {}),
		});

	it('applies a lowered and then a raised per-recipient cap to the next request', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		await saveCaps(t, { perRecipient: { isEnabled: true, count: 2, windowMs: HOUR } });

		expect((await send(t, templateId, 'ada@example.com')).ok).toBe(true);
		expect((await send(t, templateId, 'ada@example.com')).ok).toBe(true);
		const third = await send(t, templateId, 'ada@example.com');
		expect(third).toMatchObject({ ok: false, reason: 'recipient_rate_limited' });
		if (third.ok) throw new Error('expected refusal');
		expect(third.detail).toContain('2 per hour');
		expect(third.detail).toContain('instance admin');
		expect(third.retryAfterMs).toBeGreaterThan(0);

		await saveCaps(t, { perRecipient: { isEnabled: true, count: 3, windowMs: HOUR } });
		expect((await send(t, templateId, 'ada@example.com')).ok).toBe(true);
		expect((await send(t, templateId, 'ada@example.com')).ok).toBe(false);
	});

	it('applies a raised daily cap per API key to the next request', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		const keyId = await seedKey(t);
		await saveCaps(t, { perApiKeyDaily: { isEnabled: true, count: 1 } });

		expect((await send(t, templateId, 'a@example.com', keyId)).ok).toBe(true);
		const refused = await send(t, templateId, 'b@example.com', keyId);
		expect(refused).toMatchObject({ ok: false, reason: 'daily_send_limit' });
		if (refused.ok) throw new Error('expected refusal');
		// The window ends at the next UTC midnight, 14 hours from now.
		expect(refused.retryAfterMs).toBe(14 * HOUR);

		await saveCaps(t, { perApiKeyDaily: { isEnabled: true, count: 2 } });
		expect((await send(t, templateId, 'c@example.com', keyId)).ok).toBe(true);
	});

	it('never refuses on a cap that is switched off', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		const keyId = await seedKey(t);
		await saveCaps(t, {
			perRecipient: { isEnabled: false, count: 1, windowMs: HOUR },
			perApiKeyDaily: { isEnabled: false, count: 1 },
		});

		for (let i = 0; i < 4; i++) {
			expect((await send(t, templateId, 'ada@example.com', keyId)).ok).toBe(true);
		}
	});

	it('does not throttle a template that opted out of the per-recipient cap', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t);
		const keyId = await seedKey(t);
		await t.mutation(api.transactional.sendOptions.setRecipientCapExempt, {
			id: templateId,
			isExempt: true,
		});
		await saveCaps(t, { perApiKeyDaily: { isEnabled: true, count: 7 } });

		for (let i = 0; i < 7; i++) {
			expect((await send(t, templateId, 'orders@shop.example', keyId)).ok).toBe(true);
		}
		// The daily cap per key still counts the exempt template's sends.
		expect(await send(t, templateId, 'orders@shop.example', keyId)).toMatchObject({
			ok: false,
			reason: 'daily_send_limit',
		});
	});

	it('refuses a cap change from a member who is not an admin', async () => {
		const t = newTest();
		await seedBaseline(t);
		vi.mocked(getMutationContext).mockResolvedValueOnce({
			userId: 'editor-user',
			role: 'editor',
			activeOrganizationId: 'org_1',
		});

		await expect(
			saveCaps(t, { perRecipient: { isEnabled: false, count: 5, windowMs: HOUR } })
		).rejects.toThrow(/owners and admins/);
		const settings = await t.run((ctx) => ctx.db.query('instanceSettings').first());
		expect(settings?.transactionalSendCaps).toBeUndefined();
	});

	it('refuses a cap of zero or out of range, and audits a saved change', async () => {
		const t = newTest();
		await seedBaseline(t);

		await expect(
			saveCaps(t, { perRecipient: { isEnabled: true, count: 0, windowMs: HOUR } })
		).rejects.toThrow(/per-recipient cap/);
		await expect(
			saveCaps(t, { perRecipient: { isEnabled: true, count: 5, windowMs: 1_500 } })
		).rejects.toThrow(/window/);
		await expect(saveCaps(t, { perApiKeyDaily: { isEnabled: true, count: -1 } })).rejects.toThrow(
			/daily cap/
		);

		await saveCaps(t, { perApiKeyDaily: { isEnabled: false, count: 50_000 } });
		const audit = await t.run((ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'settings.transactional_send_caps_updated'))
				.collect()
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]?.details).toMatchObject({ isPerApiKeyDailyEnabled: false });
	});
});

describe('transactional.dispatch.dispatch — optional variables', () => {
	it('accepts a request that leaves out a variable the template marks optional', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t, {
			htmlContent: '<p>Order {{orderNumber}} {{giftNote}}</p>',
			dataVariablesSchema: { orderNumber: 'string', giftNote: 'string' },
		});
		await t.mutation(api.transactional.sendOptions.setVariableOptional, {
			id: templateId,
			key: 'giftNote',
			isOptional: true,
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
			dataVariables: { orderNumber: 'A-1' },
		});

		expect(outcome.ok).toBe(true);

		// Marked required again, the same request is refused.
		await t.mutation(api.transactional.sendOptions.setVariableOptional, {
			id: templateId,
			key: 'giftNote',
			isOptional: false,
		});
		const again = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'other@example.com',
			dataVariables: { orderNumber: 'A-1' },
		});
		expect(again).toMatchObject({ ok: false, reason: 'invalid_variables' });
	});

	it('still refuses a missing variable that is not optional, saying it can be marked optional', async () => {
		const t = newTest();
		const { templateId } = await seedBaseline(t, {
			htmlContent: '<p>Order {{orderNumber}} {{giftNote}}</p>',
			dataVariablesSchema: { orderNumber: 'string', giftNote: 'string' },
		});
		await t.run((ctx) => ctx.db.patch(templateId, { optionalDataVariables: ['giftNote'] }));

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id', id: templateId },
			email: 'recipient@example.com',
			dataVariables: {},
		});

		expect(outcome).toMatchObject({ ok: false, reason: 'invalid_variables' });
		if (outcome.ok) throw new Error('expected refusal');
		expect(outcome.detail).toContain('"orderNumber"');
		expect(outcome.detail).not.toContain('giftNote');
		expect(outcome.detail).toContain('mark it optional');
	});
});
