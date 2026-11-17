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
 */

import { convexTest } from 'convex-test';
import dns from 'node:dns/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { checkEmailDomainVerification } from '../domains/domains';
import { decideSenderAndVariables } from '../transactional/dispatchDecision';
import { expectScheduledFailure } from './helpers/scheduledFailures';

// The flow under test schedules the functions below, which this suite's
// module map leaves out (or which need a setup it does not make). Their jobs
// fail when they fire, often after the test that scheduled them. These tests
// are not about them.
beforeEach(() => {
	expectScheduledFailure('domains/providers/registerAction:run');
	expectScheduledFailure('domains/providers/registerAction:deleteDomainAction');
});

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

		const outcome = await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
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

		await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
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
		await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
			domain: 'activate.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		// …then activation switches signing and retires s1.
		const outcome = await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
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
		await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
			domain: 'idem.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		// A retried webhook re-delivers the identical overlap event → no change.
		const outcome = await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
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

	it('cancelled phase: withdraws the pending selector and keeps the active one', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRotatedDomain(t, 'cancel.com');
		await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
			domain: 'cancel.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});

		const outcome = await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
			domain: 'cancel.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'cancelled',
			userId: 'system:dkim_rotation',
		});

		expect(outcome).toMatchObject({ ok: true, phase: 'cancelled', changed: true });
		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dnsRecords.dkim).toEqual([
				{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=OLDKEY' },
			]);
		});
		const pendingResults = [
			{ verified: true, lastChecked: 1 },
			{ verified: false, lastChecked: 1, rotationPending: true },
		];
		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			await ctx.db.patch(domainId, {
				dnsRecords: {
					...domain!.dnsRecords,
					dkim: [
						...domain!.dnsRecords.dkim!,
						{ type: 'TXT', host: 's3._domainkey', value: 'v=DKIM1; p=X', rotationPending: true },
					],
				},
				verificationResults: { ...domain!.verificationResults, dkim: pendingResults },
			});
		});
		await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
			domain: 'cancel.com',
			selector: 's3',
			dnsRecord: 'v=DKIM1; p=X',
			phase: 'cancelled',
			userId: 'system:dkim_rotation',
		});
		await t.run(async (ctx) => {
			// The active selector keeps its verification result.
			const domain = await ctx.db.get(domainId);
			expect(domain!.verificationResults?.dkim).toEqual([pendingResults[0]]);
		});
	});

	it('cancelled phase never removes a selector that is signing', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRotatedDomain(t, 'cancel-active.com');

		const outcome = await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
			domain: 'cancel-active.com',
			selector: 's1',
			dnsRecord: 'v=DKIM1; k=rsa; p=OLDKEY',
			phase: 'cancelled',
			userId: 'system:dkim_rotation',
		});

		expect(outcome).toMatchObject({ ok: true, phase: 'cancelled', changed: false });
		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dnsRecords.dkim!.map((r) => r.host)).toEqual(['s1._domainkey']);
		});
	});

	it('returns domain_not_found for a domain the MTA does not know in Convex', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
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

		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
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

		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
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
		await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
			domainId,
			policy: 'reject',
			subdomainPolicy: 'none',
			pct: 25,
			userId: 'user',
		});

		// …then raise to full enforcement, omitting both knobs.
		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
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

		await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
			domainId,
			policy: 'quarantine',
			subdomainPolicy: 'none',
			pct: 50,
			userId: 'user',
		});

		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
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
			t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
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

		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
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

		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
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

		const outcome = await t.mutation(internal.domains.lifecycleDmarc.setDmarcPolicy, {
			domainId,
			policy: 'reject',
			userId: 'user',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('domain_not_found');
	});
});

describe('Sending domain lifecycle — re-verification of a verified domain', () => {
	const HOUR = 60 * 60 * 1000;
	const ACTIVE_KEY = 'v=DKIM1; k=rsa; p=ACTIVEKEY';
	const DMARC = 'v=DMARC1; p=none';

	const dnsError = (code: string, host: string) =>
		Object.assign(new Error(`queryTxt ${code} ${host}`), { code });

	/**
	 * Answer TXT lookups from a zone: a string list is the published records, an
	 * error code is what the resolver says instead, and a host not listed does
	 * not exist (NXDOMAIN).
	 */
	function serveZone(zone: Record<string, string[] | { fails: string }>) {
		vi.spyOn(dns, 'resolveTxt').mockImplementation(async (host: string) => {
			const answer = zone[host];
			if (answer === undefined) throw dnsError('ENOTFOUND', host);
			if (!Array.isArray(answer)) throw dnsError(answer.fails, host);
			return answer.map((value) => [value]);
		});
	}

	async function seedVerified(
		t: ReturnType<typeof convexTest>,
		domain: string,
		status: 'verified' | 'failed' = 'verified'
	): Promise<Id<'domains'>> {
		return await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain,
				status,
				dnsRecords: {
					dkim: [{ type: 'TXT', host: 's1._domainkey', value: ACTIVE_KEY }],
					dmarc: { type: 'TXT', host: '_dmarc', value: DMARC },
				},
				verificationResults: {
					dkim: [{ verified: true, lastChecked: Date.now() }],
					dmarc: { verified: true, lastChecked: Date.now() },
				},
				providerType: 'mta',
				verifiedAt: Date.now() - 30 * 24 * HOUR,
				lastVerifiedAt: Date.now() - 24 * HOUR,
				createdAt: Date.now() - 30 * 24 * HOUR,
				updatedAt: Date.now() - 24 * HOUR,
			})
		);
	}

	const statusOf = (t: ReturnType<typeof convexTest>, domainId: Id<'domains'>) =>
		t.run(async (ctx) => (await ctx.db.get(domainId))!);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('leaves verified only after a confirming check, and the send gates then refuse', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerified(t, 'dkim-gone.com');
		// The DKIM record was deleted: the zone answers NXDOMAIN for the selector.
		serveZone({ '_dmarc.dkim-gone.com': [DMARC] });

		const first = await t.action(api.domains.dnsVerification.verifyDomain, { domainId });
		expect(first.allVerified).toBe(false);
		// One answer is not enough to block every send from the domain.
		expect((await statusOf(t, domainId)).status).toBe('verified');
		expect((await statusOf(t, domainId)).regressionSuspectedAt).toBe(Date.now());

		// The confirming check the first failure scheduled runs an hour later and
		// sees the same authoritative absence.
		await vi.advanceTimersByTimeAsync(HOUR);
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const domain = await statusOf(t, domainId);
		expect(domain.status).toBe('failed');
		expect(domain.regressionSuspectedAt).toBeUndefined();
		expect(domain.verificationResults?.dkim?.[0]).toMatchObject({ verified: false });

		const gate = await t.run((ctx) => checkEmailDomainVerification(ctx, 'news@dkim-gone.com'));
		expect(gate.verified).toBe(false);
		expect(gate.error).toContain('Settings > Domains');
		expect(
			decideSenderAndVariables({
				fromEmail: 'news@dkim-gone.com',
				domainStatus: gate,
				dataVariables: undefined,
				template: { dataVariablesSchema: undefined },
				content: { subject: 'Hi', html: '<p>Hi</p>', plainText: undefined },
			})
		).toMatchObject({ ok: false, reason: 'domain_unverified' });
	});

	it('does not count a second failure inside the confirmation window', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerified(t, 'cached-nx.com');
		serveZone({ '_dmarc.cached-nx.com': [DMARC] });

		await t.action(internal.domains.reverification.reverifyDomain, { domainId });
		const suspectedAt = (await statusOf(t, domainId)).regressionSuspectedAt;
		// A resolver may hand back its cached negative answer for a while; a
		// re-check minutes later proves nothing new.
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		await t.action(internal.domains.reverification.reverifyDomain, { domainId });

		const domain = await statusOf(t, domainId);
		expect(domain.status).toBe('verified');
		expect(domain.regressionSuspectedAt).toBe(suspectedAt);
	});

	it('keeps a verified domain verified when the resolver cannot answer, and says so', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerified(t, 'servfail.com');
		serveZone({
			's1._domainkey.servfail.com': { fails: 'ESERVFAIL' },
			'_dmarc.servfail.com': [DMARC],
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, { domainId });
		expect(result).toMatchObject({ allVerified: false, inconclusive: true });

		const domain = await statusOf(t, domainId);
		expect(domain.status).toBe('verified');
		expect(domain.regressionSuspectedAt).toBeUndefined();
		// The last authoritative evidence stays on the row.
		expect(domain.verificationResults?.dkim?.[0]).toMatchObject({ verified: true });
		const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(jobs).toEqual([]);
	});

	it('does not fail the domain over a rotation selector that is not published yet', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerified(t, 'rotating.com');
		await t.mutation(internal.domains.lifecycleDkim.recordDkimRotation, {
			domain: 'rotating.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEXTKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});
		// The active selector still signs and is published; s2 is not yet.
		serveZone({
			's1._domainkey.rotating.com': [ACTIVE_KEY],
			'_dmarc.rotating.com': [DMARC],
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, { domainId });
		expect(result.allVerified).toBe(true);

		const domain = await statusOf(t, domainId);
		expect(domain.status).toBe('verified');
		expect(domain.regressionSuspectedAt).toBeUndefined();
		expect(domain.verificationResults?.dkim).toEqual([
			expect.objectContaining({ verified: true }),
			expect.objectContaining({ verified: false, rotationPending: true }),
		]);
	});

	it('returns a regressed domain to verified on the next passing check', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerified(t, 'restored.com', 'failed');
		serveZone({
			's1._domainkey.restored.com': [ACTIVE_KEY],
			'_dmarc.restored.com': [DMARC],
		});

		await t.action(internal.domains.reverification.reverifyDomain, { domainId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await statusOf(t, domainId)).status).toBe('verified');
		const gate = await t.run((ctx) => checkEmailDomainVerification(ctx, 'news@restored.com'));
		expect(gate.verified).toBe(true);
	});

	it('clears a suspicion when the record is back before the confirming check', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerified(t, 'blip.com');
		serveZone({ '_dmarc.blip.com': [DMARC] });
		await t.action(internal.domains.reverification.reverifyDomain, { domainId });
		expect((await statusOf(t, domainId)).regressionSuspectedAt).toBeDefined();

		serveZone({ 's1._domainkey.blip.com': [ACTIVE_KEY], '_dmarc.blip.com': [DMARC] });
		await vi.advanceTimersByTimeAsync(HOUR);
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const domain = await statusOf(t, domainId);
		expect(domain.status).toBe('verified');
		expect(domain.regressionSuspectedAt).toBeUndefined();
	});

	it('the daily sweep schedules one check per domain that was ever verified', async () => {
		const t = convexTest(schema, modules);
		const verified = await seedVerified(t, 'sweep-ok.com');
		const regressed = await seedVerified(t, 'sweep-failed.com', 'failed');
		await t.run(async (ctx) => {
			// Never verified: setting up is the operator's job, not the sweep's.
			await ctx.db.insert('domains', {
				domain: 'sweep-new.com',
				status: 'pending',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.domains.reverificationSweep.scheduleReverification, {});

		const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		const checked = jobs
			.filter((job) => job.name.endsWith('reverification:reverifyDomain'))
			.map((job) => (job.args[0] as { domainId: Id<'domains'> }).domainId);
		expect(checked.sort()).toEqual([verified, regressed].sort());
	});
});
