/**
 * The seed probe on the SHIPPED governed-dispatch boundary.
 *
 * A shadow copy travels the identical transport as the mail it measures, which
 * means it enters `delivery/routingReentry` — an authentication-token and
 * tenant-scoping module. This suite pins the grafted branch:
 *
 *   - `issueSnapshot` accepts a probe bound to its ledger row, and refuses a
 *     mismatched probe id, a foreign organization, or an envelope that is also
 *     a countable Send;
 *   - the `'s'` compact-token kind round-trips through encrypt/decrypt (the
 *     token decodes to a seed probe rather than failing to decode at all);
 *   - `resolveReentryTarget` DROPS a probe hand-back — a probe is disposable and
 *     has no lifecycle to resume;
 *   - the tightened legacy (v1) guard refuses a seed-probe kind, which rr1 could
 *     never have issued;
 *   - and the campaign path behaves exactly as it did before (regression).
 *
 * Plus `analytics.seedPlacement.recordSeedProbeDispatch`: the arm attribution
 * the whole placement observation hangs on, and its org scoping.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import schema from '../schema';
import { internal } from '../_generated/api';
import { SEED_PROBE_RETENTION_MS } from '../schema/seedPlacement';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import type { Id } from '../_generated/dataModel';

const enqueueAction = vi.fn().mockResolvedValue('work-1');
vi.mock('../delivery/workpool', () => ({
	campaignEmailPool: { enqueueAction },
	transactionalEmailPool: { enqueueAction },
}));

const modules = import.meta.glob('../**/*.*s');

const ORG = 'org-seed-reentry';
const PROBE_ID = 'sp_abcdefghij0123456789kl';

beforeEach(() => {
	enqueueAction.mockClear();
	vi.stubEnv('INSTANCE_SECRET', 'routing-reentry-test-secret-at-least-32-characters');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

interface ProbeFixture {
	t: ReturnType<typeof convexTest>;
	probeRef: Id<'seedPlacementProbes'>;
	envelopeInput: Record<string, unknown>;
	retryState: { attempt: number; startedAt: number; idempotencyKey: string };
}

async function probeFixture(organizationId = ORG): Promise<ProbeFixture> {
	const t = convexTest(schema, modules);
	const now = Date.now();
	const probeRef = await t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-1',
			organizationId,
			address: 'owlat.seed.01@gmail.example',
			domain: 'gmail.example',
			kind: 'external' as const,
			status: 'active' as const,
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-1',
			organizationId,
			mailboxId,
			purpose: 'seed' as const,
			seedProvider: 'gmail' as const,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 587,
			isSmtpSecure: false,
			authMethod: 'password' as const,
			imapUsername: 'seed-login',
			secretCiphertext: 'ct',
			secretIv: 'iv',
			secretAuthTag: 'tag',
			secretEnvelopeVersion: 1,
			status: 'pending' as const,
			createdAt: now,
			updatedAt: now,
		});
		return ctx.db.insert('seedPlacementProbes', {
			organizationId,
			probeId: PROBE_ID,
			accountId,
			provider: 'gmail' as const,
			stream: 'campaign' as const,
			sentAt: now,
			expiresAt: now + SEED_PROBE_RETENTION_MS,
		});
	});
	const envelopeInput = {
		kind: 'campaign' as const,
		to: 'owlat.seed.01@gmail.example',
		from: 'news@org.example',
		template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
		contactInfo: { email: 'owlat.seed.01@gmail.example' },
		organizationId: ORG,
		seedProbeId: PROBE_ID,
		seedProbeRef: probeRef,
	};
	const retryState = {
		attempt: 2,
		startedAt: Date.now(),
		idempotencyKey: `probe_${probeRef}`,
	};
	return { t, probeRef, envelopeInput, retryState };
}

function issueArgs(f: ProbeFixture) {
	return {
		sendRef: { kind: 'seedProbe' as const, id: f.probeRef },
		organizationId: ORG,
		messageId: f.retryState.idempotencyKey,
		workAttemptId: 'work-attempt-1',
		envelopeInput: f.envelopeInput as never,
		retryState: f.retryState,
	};
}

describe('issueSnapshot — the seedProbe branch', () => {
	it('issues a token for a probe whose ledger row matches the envelope', async () => {
		const f = await probeFixture();
		const issued = await f.t.mutation(internal.delivery.routingReentry.issueSnapshot, issueArgs(f));
		expect(issued.token).toMatch(/^rr2\./);
		expect(issued.expiresAt).toBeGreaterThan(Date.now());
	});

	it('refuses an envelope carrying a DIFFERENT probe id', async () => {
		const f = await probeFixture();
		await expect(
			f.t.mutation(internal.delivery.routingReentry.issueSnapshot, {
				...issueArgs(f),
				envelopeInput: {
					...f.envelopeInput,
					seedProbeId: 'sp_zzzzzzzzzz9999999999zz',
				} as never,
			})
		).rejects.toThrow(/does not belong to the seed probe/);
	});

	it('refuses a probe owned by another organization', async () => {
		const f = await probeFixture('org-somebody-else');
		await expect(
			f.t.mutation(internal.delivery.routingReentry.issueSnapshot, issueArgs(f))
		).rejects.toThrow(/does not belong to the organization/);
	});

	it('refuses an envelope that is ALSO a countable Send', async () => {
		const f = await probeFixture();
		const sendId = await f.t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			return ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});
		await expect(
			f.t.mutation(internal.delivery.routingReentry.issueSnapshot, {
				...issueArgs(f),
				envelopeInput: { ...f.envelopeInput, emailSendId: sendId } as never,
			})
		).rejects.toThrow(/does not belong to the seed probe/);
	});

	it('refuses a probe reference that no longer exists', async () => {
		const f = await probeFixture();
		await f.t.run(async (ctx) => ctx.db.delete(f.probeRef));
		await expect(
			f.t.mutation(internal.delivery.routingReentry.issueSnapshot, issueArgs(f))
		).rejects.toThrow(/existing seed probe/);
	});
});

describe("consumeSnapshot — the 's' token round-trips and the hand-back is dropped", () => {
	it('decodes as a seed probe and is DROPPED, enqueueing nothing', async () => {
		const f = await probeFixture();
		const issued = await f.t.mutation(internal.delivery.routingReentry.issueSnapshot, issueArgs(f));
		const outcome = await f.t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
			token: issued.token,
			messageId: f.retryState.idempotencyKey,
			workAttemptId: 'work-attempt-1',
			reason: 'circuit_breaker_changed' as const,
			envelopeInput: f.envelopeInput as never,
			retryState: f.retryState,
		});
		// NOT `invalid_token`: the 's' kind decoded cleanly. The probe is simply
		// disposable — there is no lifecycle to resume and no denominator that
		// would notice, so the hand-back is dropped and the ledger row stays
		// unclassified (and unclassified probes are not evidence).
		expect(outcome.disposition).toBe('snapshot_not_found');
		expect(enqueueAction).not.toHaveBeenCalled();
		const probe = await f.t.run(async (ctx) => ctx.db.get(f.probeRef));
		expect(probe?.placement).toBeUndefined();
		expect(probe?.dispatchedAt).toBeUndefined();
	});
});

// ── The legacy (rr1) guard, and the campaign regression ───────────────────

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

async function legacyToken(
	kind: 'c' | 't' | 's',
	sendId: string,
	envelopeInput: unknown,
	retryState: { attempt: number; startedAt: number; idempotencyKey: string },
	secret: string
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(canonicalJson({ envelopeInput, retryState }))
		)
	);
	const digestBase64 = btoa(String.fromCharCode(...digest))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '');
	const payload = {
		v: 1,
		k: kind,
		i: sendId,
		o: ORG,
		m: retryState.idempotencyKey,
		w: 'work-attempt-1',
		a: retryState.attempt,
		e: retryState.startedAt + GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		d: digestBase64,
	};
	const keyBytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`owlat-routing-reentry-key-v1\0${secret}`)
	);
	const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('owlat-routing-reentry:v1') },
			key,
			new TextEncoder().encode(JSON.stringify(payload))
		)
	);
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv);
	combined.set(ciphertext, iv.length);
	let binary = '';
	for (const b of combined) binary += String.fromCharCode(b);
	const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
	return `rr1.${encoded}`;
}

describe('the legacy rr1 token namespace never carried a seed probe', () => {
	it('refuses a v1 token claiming the seedProbe kind', async () => {
		const f = await probeFixture();
		const token = await legacyToken(
			's',
			f.probeRef,
			f.envelopeInput,
			f.retryState,
			'routing-reentry-test-secret-at-least-32-characters'
		);
		const outcome = await f.t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
			token,
			messageId: f.retryState.idempotencyKey,
			workAttemptId: 'work-attempt-1',
			reason: 'circuit_breaker_changed' as const,
			envelopeInput: f.envelopeInput as never,
			retryState: f.retryState,
		});
		expect(outcome.disposition).toBe('invalid_token');
		expect(enqueueAction).not.toHaveBeenCalled();
	});
});

describe('regression — the campaign token behaves exactly as before', () => {
	it('issues, decodes, and re-enqueues a queued campaign Send', async () => {
		const t = convexTest(schema, modules);
		const sendId = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			return ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'queued',
					providerMessageId: undefined,
				})
			);
		});
		const envelopeInput = {
			kind: 'campaign' as const,
			to: 'person@example.com',
			from: 'sender@example.org',
			template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
			contactInfo: { email: 'person@example.com' },
			emailSendId: sendId,
			organizationId: ORG,
		};
		const retryState = { attempt: 2, startedAt: Date.now(), idempotencyKey: `send_${sendId}` };
		const issued = await t.mutation(internal.delivery.routingReentry.issueSnapshot, {
			sendRef: { kind: 'campaign', id: sendId },
			organizationId: ORG,
			messageId: retryState.idempotencyKey,
			workAttemptId: 'work-attempt-1',
			envelopeInput,
			retryState,
		});
		const outcome = await t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
			token: issued.token,
			messageId: retryState.idempotencyKey,
			workAttemptId: 'work-attempt-1',
			reason: 'circuit_breaker_changed' as const,
			envelopeInput,
			retryState,
		});
		expect(outcome.disposition).toBe('enqueued');
		expect(enqueueAction).toHaveBeenCalledTimes(1);
	});
});

describe('recordSeedProbeDispatch — arm attribution', () => {
	it('records the arm the route ACTUALLY resolved to, and the dispatch time', async () => {
		const f = await probeFixture();
		const at = Date.now();
		expect(
			await f.t.mutation(internal.analytics.seedPlacement.recordSeedProbeDispatch, {
				organizationId: ORG,
				probeRef: f.probeRef,
				transportArm: 'own',
				now: at,
			})
		).toEqual({ recorded: true });
		const probe = await f.t.run(async (ctx) => ctx.db.get(f.probeRef));
		expect(probe?.transportArm).toBe('own');
		expect(probe?.dispatchedAt).toBe(at);
	});

	it('records the reference arm just as readily', async () => {
		const f = await probeFixture();
		await f.t.mutation(internal.analytics.seedPlacement.recordSeedProbeDispatch, {
			organizationId: ORG,
			probeRef: f.probeRef,
			transportArm: 'reference',
			now: Date.now(),
		});
		const probe = await f.t.run(async (ctx) => ctx.db.get(f.probeRef));
		expect(probe?.transportArm).toBe('reference');
	});

	it('refuses a dispatch record from another organization', async () => {
		const f = await probeFixture();
		expect(
			await f.t.mutation(internal.analytics.seedPlacement.recordSeedProbeDispatch, {
				organizationId: 'org-somebody-else',
				probeRef: f.probeRef,
				transportArm: 'own',
				now: Date.now(),
			})
		).toEqual({ recorded: false, reason: 'foreign_organization' });
		const probe = await f.t.run(async (ctx) => ctx.db.get(f.probeRef));
		expect(probe?.dispatchedAt).toBeUndefined();
	});
});
