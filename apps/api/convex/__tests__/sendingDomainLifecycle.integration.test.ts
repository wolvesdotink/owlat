/**
 * Sending domain lifecycle (module) — integration tests.
 *
 * Covers:
 *   - `create()` happy path + invalid format + duplicate
 *   - `transition({ to: 'pending' })` writes identity sibling row atomically
 *   - `transition({ to: 'registering' })` clears identity row + re-fires register
 *   - `transition({ to: 'verified' })` sets verifiedAt (first time) and preserves it
 *   - `recordVerification()` derives next status from DNS + provider check
 *   - `remove()` clears sibling identity + schedules provider cleanup
 *   - Audit log fires on every transition
 *   - Illegal edges return `{ ok: false, reason: 'illegal_edge' }`
 *
 * Per ADR-0018.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

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

// Exclude provider register actions — they require AWS / MTA credentials.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('providers/registerAction'))
);

describe('Sending domain lifecycle — create', () => {
	it('creates row at registering with audit log and provider register effect', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'example.com',
			userId: 'user',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(outcome.domainId);
			expect(domain).toBeDefined();
			expect(domain!.status).toBe('registering');
			expect(domain!.domain).toBe('example.com');
			expect(domain!.providerType).toMatch(/^(mta|ses)$/);

			// Audit row fired.
			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), outcome.domainId))
				.collect();
			const actions = audits.map((a) => a.action);
			expect(actions).toContain('sending_domain.created');
		});

		await t.finishInProgressScheduledFunctions();
	});

	it('rejects invalid format', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'not a domain',
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('invalid_format');
		}
	});

	it('rejects duplicate domain', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.domains.lifecycle.create, {
			domain: 'dup.com',
			userId: 'user',
		});
		await t.finishInProgressScheduledFunctions();

		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'dup.com',
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('already_exists');
		}
	});
});

describe('Sending domain lifecycle — transition to pending (register-completion)', () => {
	it('writes MTA identity sibling row + audit log', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'mta-test.com',
				status: 'registering',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: {
				to: 'pending',
				at: Date.now(),
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=AAA' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
				},
				identity: { kind: 'mta', dkimSelector: 's1' },
			},
			userId: 'system:provider_register',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.from).toBe('registering');
		expect(outcome.to).toBe('pending');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('pending');
			expect(domain!.dnsRecords).toBeDefined();

			const identities = await ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId!))
				.collect();
			expect(identities).toHaveLength(1);
			expect(identities[0]!.dkimSelector).toBe('s1');

			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			const actions = audits.map((a) => a.action);
			expect(actions).toContain('sending_domain.registered');
		});
	});

	it('writes SES identity sibling row with multiple DKIM tokens', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'ses-test.com',
				status: 'registering',
				dnsRecords: {},
				providerType: 'ses',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: {
				to: 'pending',
				at: Date.now(),
				dnsRecords: { dkim: [] },
				identity: {
					kind: 'ses',
					dkimTokens: ['t1', 't2', 't3'],
					verificationToken: 'verify-xyz',
				},
			},
			userId: 'system:provider_register',
		});

		await t.run(async (ctx) => {
			const identities = await ctx.db
				.query('sendingDomainSesIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId!))
				.collect();
			expect(identities).toHaveLength(1);
			expect(identities[0]!.dkimTokens).toEqual(['t1', 't2', 't3']);
			expect(identities[0]!.verificationToken).toBe('verify-xyz');
		});
	});

	it('registering → failed with error patches lastRegistrationError', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'failreg.com',
				status: 'registering',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: {
				to: 'failed',
				at: Date.now(),
				error: 'MTA API unreachable',
			},
			userId: 'system:provider_register',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('failed');
			expect(domain!.lastRegistrationError).toBe('MTA API unreachable');

			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.registration_failed');
		});
	});
});

describe('Sending domain lifecycle — verification', () => {
	it('all-records-pass + provider verified → verified, sets verifiedAt', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'verify-ok.com',
				status: 'pending',
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'k' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: 'd' },
				},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.recordVerification, {
			domainId: domainId!,
			verificationResults: {
				dkim: [{ verified: true, lastChecked: Date.now() }],
				dmarc: { verified: true, lastChecked: Date.now() },
			},
			providerCheck: { verified: true },
			userId: 'system:verifier',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('verified');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('verified');
			expect(domain!.verifiedAt).toBeTypeOf('number');
			expect(domain!.lastVerifiedAt).toBeTypeOf('number');
		});
	});

	it('preserves verifiedAt on re-verification', async () => {
		const t = convexTest(schema, modules);
		const firstVerifiedAt = Date.now() - 100000;
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'reverify.com',
				status: 'verified',
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'k' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: 'd' },
				},
				providerType: 'mta',
				verifiedAt: firstVerifiedAt,
				createdAt: Date.now() - 200000,
				updatedAt: Date.now() - 100000,
			});
		});

		await t.mutation(internal.domains.lifecycle.recordVerification, {
			domainId: domainId!,
			verificationResults: {
				dkim: [{ verified: true, lastChecked: Date.now() }],
				dmarc: { verified: true, lastChecked: Date.now() },
			},
			providerCheck: { verified: true },
			userId: 'system:verifier',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.verifiedAt).toBe(firstVerifiedAt);
			expect(domain!.lastVerifiedAt).toBeTypeOf('number');
		});
	});

	it('DNS failure → failed', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'verifyfail.com',
				status: 'pending',
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'k' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: 'd' },
				},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.recordVerification, {
			domainId: domainId!,
			verificationResults: {
				dkim: [{ verified: false, lastChecked: Date.now(), error: 'no record' }],
				dmarc: { verified: true, lastChecked: Date.now() },
			},
			providerCheck: { verified: true },
			userId: 'system:verifier',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('failed');
	});

	it('provider check failure → failed even if DNS passes', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'sescheck.com',
				status: 'pending',
				dnsRecords: {
					dkim: [{ type: 'CNAME', host: 't1._domainkey', value: 't1.dkim.amazonses.com' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: 'd' },
				},
				providerType: 'ses',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.recordVerification, {
			domainId: domainId!,
			verificationResults: {
				dkim: [{ verified: true, lastChecked: Date.now() }],
				dmarc: { verified: true, lastChecked: Date.now() },
			},
			providerCheck: { verified: false, lastError: 'SES status: Pending' },
			userId: 'system:verifier',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('failed');
	});

	it('some pending none failed → pending self-loop with patched results', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'inprogress.com',
				status: 'pending',
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'k' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: 'd' },
				},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.recordVerification, {
			domainId: domainId!,
			verificationResults: {
				// dmarc missing — no record present
				dkim: [{ verified: true, lastChecked: Date.now() }],
			},
			providerCheck: { verified: true },
			userId: 'system:verifier',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('pending');
		expect(outcome.applied).toBe('recorded');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('pending');
			expect(domain!.verificationResults).toBeDefined();
			expect(domain!.lastVerifiedAt).toBeTypeOf('number');
		});
	});
});

describe('Sending domain lifecycle — reservation provisioning on → verified', () => {
	it('provisions an already-accepted reservation end-to-end through the real edge', async () => {
		// The whole early-instance-invite promise: a mailbox reserved on a
		// still-unverified domain, whose invitee already accepted (parked with
		// acceptedByUserId), must materialize the moment the domain verifies —
		// driven through the real pending → verified transition, not by importing
		// the sweep helper. The → verified edge SCHEDULES the sweep, so we drain
		// scheduled functions before asserting the mailbox stood up.
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'activates.com',
				status: 'pending',
				dnsRecords: { dkim: [] },
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('pendingMailboxes', {
				invitationId: 'inv-verify',
				inviteeEmail: 'accepted@example.com',
				organizationId: 'test-org',
				localpart: 'accepted',
				domain: 'activates.com',
				address: 'accepted@activates.com',
				createdAt: Date.now(),
				createdByUserId: 'admin-user',
				// Stamped at accept time — only stamped rows are swept.
				acceptedByUserId: 'accepted-user',
			});
		});

		// The → verified edge SCHEDULES the sweep (runAfter(0)), which in turn
		// schedules the mailbox cache-push — drain both under fake timers.
		vi.useFakeTimers();
		try {
			const outcome = await t.mutation(internal.domains.lifecycle.transition, {
				domainId: domainId!,
				input: { to: 'verified', at: Date.now(), verificationResults: {} },
				userId: 'user',
			});
			expect(outcome.ok).toBe(true);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		await t.run(async (ctx) => {
			// The reserved mailbox materialized, owned by the recorded accept-time id.
			const mailbox = await ctx.db
				.query('mailboxes')
				.withIndex('by_address', (q) => q.eq('address', 'accepted@activates.com'))
				.first();
			expect(mailbox).not.toBeNull();
			expect(mailbox!.userId).toBe('accepted-user');
			expect(mailbox!.status).toBe('active');

			// The reservation was consumed, not left dangling.
			const remaining = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_domain', (q) => q.eq('domain', 'activates.com'))
				.collect();
			expect(remaining).toHaveLength(0);
		});
	});

	it('leaves an un-accepted reservation parked until its invitee accepts', async () => {
		// A reservation with no acceptedByUserId (invitee hasn't accepted yet) must
		// NOT be provisioned by the verify-time sweep — it materializes later
		// through the normal accept-time claim once the domain is verified.
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'unaccepted.com',
				status: 'pending',
				dnsRecords: { dkim: [] },
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('pendingMailboxes', {
				invitationId: 'inv-parked',
				inviteeEmail: 'parked@example.com',
				organizationId: 'test-org',
				localpart: 'parked',
				domain: 'unaccepted.com',
				address: 'parked@unaccepted.com',
				createdAt: Date.now(),
				createdByUserId: 'admin-user',
			});
		});

		vi.useFakeTimers();
		try {
			const outcome = await t.mutation(internal.domains.lifecycle.transition, {
				domainId: domainId!,
				input: { to: 'verified', at: Date.now(), verificationResults: {} },
				userId: 'user',
			});
			expect(outcome.ok).toBe(true);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		await t.run(async (ctx) => {
			const mailbox = await ctx.db
				.query('mailboxes')
				.withIndex('by_address', (q) => q.eq('address', 'parked@unaccepted.com'))
				.first();
			expect(mailbox).toBeNull();

			// The reservation is preserved for the invitee's own accept-time claim.
			const remaining = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_domain', (q) => q.eq('domain', 'unaccepted.com'))
				.collect();
			expect(remaining).toHaveLength(1);
		});
	});
});

describe('Sending domain lifecycle — regenerate', () => {
	it('verified → registering clears identity row + verification fields', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'regen.com',
				status: 'verified',
				dnsRecords: { dkim: [] },
				providerType: 'mta',
				verifiedAt: Date.now() - 100000,
				lastVerifiedAt: Date.now() - 50000,
				verificationResults: { dkim: [{ verified: true, lastChecked: Date.now() - 50000 }] },
				createdAt: Date.now() - 200000,
				updatedAt: Date.now() - 50000,
			});
			await ctx.db.insert('sendingDomainMtaIdentities', {
				domainId: domainId,
				dkimSelector: 'old-sel',
				createdAt: Date.now() - 100000,
				updatedAt: Date.now() - 100000,
			});
		});

		await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: { to: 'registering', at: Date.now() },
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('registering');
			expect(domain!.dnsRecords).toEqual({});
			expect(domain!.verifiedAt).toBeUndefined();
			expect(domain!.lastVerifiedAt).toBeUndefined();
			expect(domain!.verificationResults).toBeUndefined();

			const identities = await ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId!))
				.collect();
			expect(identities).toHaveLength(0);

			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.regenerated');
		});

		await t.finishInProgressScheduledFunctions();
	});
});

describe('Sending domain lifecycle — remove', () => {
	it('removes both MTA and SES identities for a hybrid domain', async () => {
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('domains', {
				domain: 'hybrid.example.com',
				status: 'verified',
				dnsRecords: { dkim: [] },
				providerType: 'mta',
				verifiedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainMtaIdentities', {
				domainId: id,
				dkimSelector: 'owlat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId: id,
				dkimTokens: ['one', 'two', 'three'],
				verificationToken: 'verified',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return id;
		});

		expect(
			await t.mutation(internal.domains.lifecycle.remove, {
				domainId,
				userId: 'user',
			})
		).toEqual({ ok: true });
		const providerDeletes = await t.run(async (ctx) => {
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			return scheduled
				.filter((job) => job.name.includes('deleteDomainAction'))
				.map((job) => job.args[0] as { providerType: string; domain: string });
		});
		expect(providerDeletes).toEqual(
			expect.arrayContaining([
				{ providerType: 'mta', domain: 'hybrid.example.com' },
				{ providerType: 'ses', domain: 'hybrid.example.com' },
			])
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(domainId)).toBeNull();
			expect(await ctx.db.query('sendingDomainMtaIdentities').collect()).toHaveLength(0);
			expect(await ctx.db.query('sendingDomainSesIdentities').collect()).toHaveLength(0);
		});
	});

	it('removes domain + sibling identity + audit log', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'gone.com',
				status: 'verified',
				dnsRecords: { dkim: [] },
				providerType: 'ses',
				verifiedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId: domainId,
				dkimTokens: ['t1', 't2', 't3'],
				verificationToken: 'v',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.remove, {
			domainId: domainId!,
			userId: 'user',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain).toBeNull();

			const identities = await ctx.db
				.query('sendingDomainSesIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId!))
				.collect();
			expect(identities).toHaveLength(0);

			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.deleted');
		});

		await t.finishInProgressScheduledFunctions();
	});

	it('clears pending-mailbox reservations on the removed domain (no stranded invitees)', async () => {
		// A removed domain will never verify, so any reservations parked on it must
		// be dropped — otherwise their invitees sit on "activates when your domain
		// verifies" forever. remove() calls clearReservationsForDomain atomically.
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'reserved-gone.com',
				status: 'pending',
				dnsRecords: { dkim: [] },
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('pendingMailboxes', {
				invitationId: 'inv-remove',
				inviteeEmail: 'invitee@example.com',
				organizationId: 'test-org',
				localpart: 'invitee',
				domain: 'reserved-gone.com',
				address: 'invitee@reserved-gone.com',
				createdAt: Date.now(),
				createdByUserId: 'admin-user',
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.remove, {
			domainId: domainId!,
			userId: 'user',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const remaining = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_domain', (q) => q.eq('domain', 'reserved-gone.com'))
				.collect();
			expect(remaining).toHaveLength(0);
		});

		await t.finishInProgressScheduledFunctions();
	});

	it('returns { ok: false, reason: domain_not_found } for non-existent', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'gone.com',
				status: 'pending',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(domainId);
		});

		const outcome = await t.mutation(internal.domains.lifecycle.remove, {
			domainId: domainId!,
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('domain_not_found');
		}
	});
});

describe('Sending domain lifecycle — illegal edges', () => {
	it('registering → verified is illegal', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'illegal.com',
				status: 'registering',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: {
				to: 'verified',
				at: Date.now(),
				verificationResults: {},
			},
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('illegal_edge');
		}
	});

	it('returns domain_not_found for unknown domain', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'gone.com',
				status: 'registering',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(domainId);
		});

		const outcome = await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: { to: 'registering', at: Date.now() },
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('domain_not_found');
		}
	});
});

describe('Sending domain provider adapter — identity round-trip', () => {
	it('MTA writeIdentity round-trips through the lifecycle', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'mtaprov.com',
				status: 'registering',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// `registering → pending` exercises writeIdentity through the lifecycle.
		await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: {
				to: 'pending',
				at: Date.now(),
				dnsRecords: { dkim: [] },
				identity: { kind: 'mta', dkimSelector: 'sel-1' },
			},
			userId: 'system:provider_register',
		});

		// Regenerate → registering clears the sibling row…
		await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: { to: 'registering', at: Date.now() },
			userId: 'user',
		});

		// …then `registering → pending` with a fresh identity inserts a new
		// row. The adapter's `writeIdentity` upserts, so no duplicate.
		await t.mutation(internal.domains.lifecycle.transition, {
			domainId: domainId!,
			input: {
				to: 'pending',
				at: Date.now(),
				dnsRecords: { dkim: [] },
				identity: { kind: 'mta', dkimSelector: 'sel-2' },
			},
			userId: 'system:provider_register',
		});

		await t.run(async (ctx) => {
			const identities = await ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId!))
				.collect();
			expect(identities).toHaveLength(1);
			expect(identities[0]!.dkimSelector).toBe('sel-2');
		});

		await t.finishInProgressScheduledFunctions();
	});
});

describe('Sending domain lifecycle — recordDkimRotation (MTA→Convex propagation)', () => {
	// Seeds a verified MTA domain registered with selector `s1`, mirroring what
	// the MTA provider's `registerDomain` writes (host `${selector}._domainkey`).
	async function seedRotatedDomain(
		t: ReturnType<typeof convexTest>,
		domain: string
	): Promise<Id<'domains'>> {
		return await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain,
				status: 'verified',
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=OLDKEY' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
				},
				verificationResults: {
					dkim: [{ verified: true, lastChecked: Date.now() }],
					dmarc: { verified: true, lastChecked: Date.now() },
				},
				providerType: 'mta',
				verifiedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
	}

	it('overlap phase: adds the new selector record while keeping the old one (RFC 6376 §3.6.1)', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRotatedDomain(t, 'rotate.com');

		const outcome = await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'rotate.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.phase).toBe('pending');
		expect(outcome.selector).toBe('s2');
		expect(outcome.changed).toBe(true);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			const dkim = domain!.dnsRecords.dkim!;
			const hosts = dkim.map((r) => r.host);
			// Both the active (s1) and the new (s2) selector are published during
			// the overlap so in-flight mail still verifies.
			expect(hosts).toContain('s1._domainkey');
			expect(hosts).toContain('s2._domainkey');
			// The new record carries the new public key.
			expect(dkim.find((r) => r.host === 's2._domainkey')!.value).toBe('v=DKIM1; k=rsa; p=NEWKEY');
			// The stale per-selector DKIM verification is dropped so the UI prompts
			// a re-publish + re-verify of the new selector.
			expect(domain!.verificationResults?.dkim).toBeUndefined();

			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.dkim_rotated');
		});
	});

	it('verifyDomain would check the s2 host after the overlap propagation', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRotatedDomain(t, 'verifyhost.com');

		await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'verifyhost.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// `dnsVerification.runDnsLookups` derives each DKIM lookup hostname as
			// `${dkimRecord.host}.${domain}`. Asserting the stored host proves the
			// verifier now queries `s2._domainkey.verifyhost.com`, not the stale
			// `s1._domainkey.verifyhost.com` only.
			const lookupHosts = domain!.dnsRecords.dkim!.map((r) => `${r.host}.${domain!.domain}`);
			expect(lookupHosts).toContain('s2._domainkey.verifyhost.com');
		});
	});

	it('activated phase: retires the old selector, leaving only the new one', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRotatedDomain(t, 'activate.com');

		// Overlap first…
		await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'activate.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		// …then activation switches signing and retires s1.
		const outcome = await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'activate.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'activated',
			userId: 'system:dkim_rotation',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.phase).toBe('activated');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			const hosts = domain!.dnsRecords.dkim!.map((r) => r.host);
			expect(hosts).toEqual(['s2._domainkey']);
			expect(hosts).not.toContain('s1._domainkey');
		});
	});

	it('is a no-op when the new selector record is already present (idempotent re-delivery)', async () => {
		const t = convexTest(schema, modules);
		await seedRotatedDomain(t, 'idem.com');

		// Land the overlap once.
		await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'idem.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		// A retried webhook re-delivers the identical overlap event → no change.
		const outcome = await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'idem.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(false);
	});

	it('returns domain_not_found for a domain the MTA does not know in Convex', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'unknown-to-convex.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('domain_not_found');
	});
});

describe('Sending domain lifecycle — setDmarcPolicy', () => {
	async function seedPendingDomain(
		t: ReturnType<typeof convexTest>,
		domain: string
	): Promise<Id<'domains'>> {
		return await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain,
				status: 'pending',
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; p=AAA' }],
					dmarc: { type: 'TXT', host: '_dmarc', value: `v=DMARC1; p=none` },
				},
				verificationResults: {
					dmarc: { verified: true, lastChecked: Date.now() },
				},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
	}

	it('raises the policy, regenerates the _dmarc record, and clears the stale DMARC verification', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'raise.com');

		const outcome = await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'reject',
			userId: 'user',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(true);
		expect(outcome.policy).toBe('reject');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dmarcPolicy).toBe('reject');
			// No MTA_DMARC_RUA configured in tests, so no `rua=` tag is emitted.
			expect(domain!.dnsRecords.dmarc!.value).toBe('v=DMARC1; p=reject');
			// Stale DMARC verification dropped so the customer re-publishes.
			expect(domain!.verificationResults?.dmarc).toBeUndefined();

			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.dmarc_policy_changed');
		});
	});

	it('round-trips dmarcSubdomainPolicy + dmarcPct through the record value', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'rollout.com');

		const outcome = await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'reject',
			subdomainPolicy: 'none',
			pct: 10,
			userId: 'user',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(true);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dmarcPolicy).toBe('reject');
			expect(domain!.dmarcSubdomainPolicy).toBe('none');
			expect(domain!.dmarcPct).toBe(10);
			// No MTA_DMARC_RUA configured in tests, so no `rua=` tag is emitted.
			expect(domain!.dnsRecords.dmarc!.value).toBe('v=DMARC1; p=reject; sp=none; pct=10');
		});
	});

	it('clears dmarcSubdomainPolicy + dmarcPct (and their tags) when omitted', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'clearstaged.com');

		// First set the staged-rollout knobs…
		await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'reject',
			subdomainPolicy: 'none',
			pct: 25,
			userId: 'user',
		});

		// …then raise to full enforcement, omitting both knobs.
		const outcome = await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'reject',
			userId: 'user',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(true);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dmarcSubdomainPolicy).toBeUndefined();
			expect(domain!.dmarcPct).toBeUndefined();
			expect(domain!.dnsRecords.dmarc!.value).toBe('v=DMARC1; p=reject');
		});
	});

	it('is a no-op when policy, subdomainPolicy, and pct all match', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'staged-noop.com');

		await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'quarantine',
			subdomainPolicy: 'none',
			pct: 50,
			userId: 'user',
		});

		const outcome = await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'quarantine',
			subdomainPolicy: 'none',
			pct: 50,
			userId: 'user',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(false);
	});

	it('throws when pct is outside the 0–100 range', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'badpct.com');

		await expect(
			t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
				domainId,
				policy: 'reject',
				pct: 150,
				userId: 'user',
			})
		).rejects.toThrow();
	});

	it('is a no-op when the policy is unchanged (defaults to none)', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'noop.com');

		const outcome = await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'none',
			userId: 'user',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(false);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// Verification untouched on a no-op.
			expect(domain!.verificationResults?.dmarc?.verified).toBe(true);
		});
	});

	it('returns no_dmarc_record when the domain has no DMARC record yet', async () => {
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain: 'noregister.com',
				status: 'registering',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		const outcome = await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'quarantine',
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('no_dmarc_record');
	});

	it('returns domain_not_found for a missing domain', async () => {
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('domains', {
				domain: 'gone.com',
				status: 'pending',
				dnsRecords: { dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' } },
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const outcome = await t.mutation(internal.domains.lifecycle.setDmarcPolicy, {
			domainId,
			policy: 'reject',
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('domain_not_found');
	});
});
