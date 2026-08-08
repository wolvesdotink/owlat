/**
 * "Who put this here?" — the read that makes a provider-driven suppression
 * distinguishable from a colleague's decision (plan D9, piece P3.2).
 *
 * A Mandrill reject lands in `blockedEmails` with no operator behind it, and
 * (for `unsub`/rule rejects) with reason `manual` — indistinguishable on the row
 * from someone typing the address into the blocklist form. Provenance lives in
 * the `blocklist.provider_suppressed` audit entry instead of a column, because
 * it is an EVENT: re-blocking an already-blocked address writes nothing, so a
 * column would only ever record whichever cause happened to arrive first.
 *
 * What this suite pins is the JOIN KEY and the SILENCE: every entry has to point
 * at the blocklist row it explains, and a row nobody reported must produce no
 * entry at all — a screen that guessed would attribute a human's decision to a
 * provider.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { modules } from './testModules';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a'),
		requireOrgMember: vi.fn(async () => ({ userId: 'test-user', role: 'admin' as const })),
		requireOrgPermission: vi.fn(async () => ({ userId: 'test-user', role: 'admin' as const })),
	};
});

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

const provenance = (t: ReturnType<typeof convexTest>) =>
	t.withIdentity(identity).query(api.blockedEmails.listProviderProvenance, {});

describe('blockedEmails.listProviderProvenance', () => {
	it('keys each entry to the blocklist row it explains', async () => {
		const t = convexTest(schema, modules);
		const blockedId = await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'rejected@example.com',
			reason: 'manual',
			provenance: {
				provider: 'mandrill',
				source: 'webhook',
				evidence: 'MANDRILL_REJECT_RULE',
			},
		});

		expect(await provenance(t)).toEqual([
			{
				blockedEmailId: blockedId,
				provider: 'mandrill',
				source: 'webhook',
				evidence: 'MANDRILL_REJECT_RULE',
				recordedAt: expect.any(Number),
			},
		]);
	});

	it('says nothing about a suppression a person actually made', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'typed-in@example.com',
			reason: 'manual',
		});

		expect(await provenance(t)).toEqual([]);
	});

	it('carries a carry-over import apart from ongoing webhook feedback', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'imported@example.com',
			reason: 'complained',
			provenance: { provider: 'mandrill', source: 'import' },
		});

		const [entry] = await provenance(t);
		expect(entry?.source).toBe('import');
		// No reason code came with the list; the screen must not invent one.
		expect(entry?.evidence).toBeNull();
	});

	it('records nothing extra when a replayed batch re-blocks the same address', async () => {
		// The audit entry follows the state change, and a replay changes nothing —
		// so the screen keeps showing one cause rather than a growing list.
		const t = convexTest(schema, modules);
		const args = {
			email: 'replayed@example.com',
			reason: 'bounced' as const,
			bounceType: 'hard' as const,
			provenance: { provider: 'mandrill', source: 'webhook' as const, evidence: 'X' },
		};
		await t.mutation(internal.blockedEmails.addFromEvent, args);
		await t.mutation(internal.blockedEmails.addFromEvent, args);

		expect(await provenance(t)).toHaveLength(1);
	});

	it('drops an entry that lost its resource id rather than guessing a row', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('auditLogs', {
				userId: 'system:mandrill_webhook',
				action: 'blocklist.provider_suppressed',
				resource: 'blocklist',
				details: { provider: 'mandrill', source: 'webhook' },
				createdAt: Date.now(),
			});
		});

		expect(await provenance(t)).toEqual([]);
	});
});
