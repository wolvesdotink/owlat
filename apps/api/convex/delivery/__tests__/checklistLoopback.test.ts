import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { DELIVERABILITY_CHECKLIST } from '@owlat/shared';
import { createDeliverabilityProbeToken } from '@owlat/shared/deliverabilityProbeToken';
import { createHash } from 'node:crypto';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import schema from '../../schema';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };
const originalSecret = process.env['MTA_WEBHOOK_SECRET'];

afterEach(() => {
	if (originalSecret === undefined) delete process.env['MTA_WEBHOOK_SECRET'];
	else process.env['MTA_WEBHOOK_SECRET'] = originalSecret;
});

async function seedAttempt(
	t: ReturnType<typeof convexTest>,
	hash: string,
	now: number,
	expiresAt = now + 60_000
) {
	return t.run(async (ctx) => {
		const domainId = await ctx.db.insert('domains', {
			domain: 'probe.example',
			status: 'verified',
			dnsRecords: {},
			providerType: 'mta',
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('deliverabilityLoopbackAttempts', {
			organizationId: 'org',
			attemptId: `attempt:${hash}`,
			domainId,
			domain: 'probe.example',
			correlationTokenHash: hash,
			status: 'sending',
			startedAt: now,
			expiresAt,
		});
		return domainId;
	});
}

describe('Deliverability Center loopback state', () => {
	it('does not downgrade an inbound-completed race and consumes the correlation once', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'probe.example',
				status: 'verified',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: now,
				updatedAt: now,
			})
		);
		await t.run((ctx) =>
			ctx.db.insert('deliverabilityLoopbackAttempts', {
				organizationId: 'org',
				attemptId: 'attempt',
				domainId,
				domain: 'probe.example',
				correlationTokenHash: 'hash',
				status: 'sending',
				startedAt: now,
				expiresAt: now + 60_000,
			})
		);
		const evidence = {
			correlationTokenHash: 'hash',
			spf: 'pass' as const,
			dkim: 'pass' as const,
			dmarc: 'pass' as const,
			dkimSelector: 's1',
			tlsVersion: 'TLSv1.3',
			sendingIp: '203.0.113.10',
			ptr: 'mail.example',
			now,
		};
		await expect(
			t.mutation(internal.delivery.checklistLoopbackState.recordInboundEvidence, evidence)
		).resolves.toMatchObject({ recorded: true, status: 'passed' });
		await expect(
			t.mutation(internal.delivery.checklistLoopbackState.markAccepted, {
				organizationId: 'org',
				attemptId: 'attempt',
				providerMessageId: 'provider-id',
			})
		).resolves.toBe('passed');
		await expect(
			t.mutation(internal.delivery.checklistLoopbackState.markSendFailed, {
				organizationId: 'org',
				attemptId: 'attempt',
				detail: 'late provider error',
				now,
			})
		).resolves.toBe('passed');
		await expect(
			t.mutation(internal.delivery.checklistLoopbackState.recordInboundEvidence, evidence)
		).resolves.toEqual({ recorded: false });
	});

	it.each([
		['TLSv1.2', 's1', '203.0.113.10', 'mail.example', 'pass', true],
		['TLSv1.3', 's1', '2001:db8::10', 'mail.example', 'pass', true],
		['plaintext', 's1', '203.0.113.10', 'mail.example', 'pass', false],
		['TLSv1.1', 's1', '203.0.113.10', 'mail.example', 'pass', false],
		['TLSv1.3', undefined, '203.0.113.10', 'mail.example', 'pass', false],
		['TLSv1.3', '.bad', '203.0.113.10', 'mail.example', 'pass', false],
		['TLSv1.3', 'a..b', '203.0.113.10', 'mail.example', 'pass', false],
		['TLSv1.3', 'bad-', '203.0.113.10', 'mail.example', 'pass', false],
		['TLSv1.3', 's1', 'not-an-ip', 'mail.example', 'pass', false],
		['TLSv1.3', 's1', '203.0.113.10', 'missing', 'pass', false],
		['TLSv1.3', 's1', '203.0.113.10', 'bogus', 'pass', false],
		['TLSv1.3', 's1', '203.0.113.10', '   ', 'pass', false],
		['TLSv1.3', 's1', '203.0.113.10', 'mail.example', 'fail', false],
	] as const)(
		'enforces the full auth/transport identity matrix %#',
		async (tlsVersion, dkimSelector, sendingIp, ptr, spf, shouldPass) => {
			const t = convexTest(schema, modules);
			const now = Date.now();
			await seedAttempt(t, 'matrix-hash', now);
			const result = await t.mutation(
				internal.delivery.checklistLoopbackState.recordInboundEvidence,
				{
					correlationTokenHash: 'matrix-hash',
					spf,
					dkim: 'pass',
					dmarc: 'pass',
					...(dkimSelector ? { dkimSelector } : {}),
					tlsVersion,
					sendingIp,
					ptr,
					now,
				}
			);
			expect(result).toMatchObject({
				recorded: true,
				status: shouldPass ? 'passed' : 'failed',
			});
		}
	);

	it('rejects unknown, expired, and forged-HMAC inbound observations', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await seedAttempt(t, 'expired', now, now - 1);
		const base = {
			spf: 'pass' as const,
			dkim: 'pass' as const,
			dmarc: 'pass' as const,
			dkimSelector: 's1',
			tlsVersion: 'TLSv1.3',
			sendingIp: '203.0.113.10',
			ptr: 'mail.example',
			now,
		};
		await expect(
			t.mutation(internal.delivery.checklistLoopbackState.recordInboundEvidence, {
				...base,
				correlationTokenHash: 'unknown',
			})
		).resolves.toEqual({ recorded: false });
		await expect(
			t.mutation(internal.delivery.checklistLoopbackState.recordInboundEvidence, {
				...base,
				correlationTokenHash: 'expired',
			})
		).resolves.toEqual({ recorded: false });

		process.env['MTA_WEBHOOK_SECRET'] = 'loopback-secret';
		const token = createDeliverabilityProbeToken('loopback-secret', now + 60_000);
		await seedAttempt(t, createHash('sha256').update(token).digest('hex'), now);
		const actionEvidence = {
			token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
			spf: 'pass' as const,
			dkim: 'pass' as const,
			dmarc: 'pass' as const,
			dkimSelector: 's1',
			tlsVersion: 'TLSv1.3',
			sendingIp: '203.0.113.10',
			ptr: 'mail.example',
		};
		await expect(
			t.action(internal.delivery.checklistLoopback.recordInbound, actionEvidence)
		).resolves.toEqual({ recorded: false });
		await expect(
			t.action(internal.delivery.checklistLoopback.recordInbound, {
				...actionEvidence,
				token,
			})
		).resolves.toMatchObject({ recorded: true, status: 'passed' });
	});

	it('allows an MTA legacy domain without a custom return-path after real prerequisites pass', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const organizationId = 'legacy-org';
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'legacy.example',
				status: 'verified',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: now,
				updatedAt: now,
			})
		);
		const ptrEvidenceId = await t.run(async (ctx) => {
			let ptrEvidenceId: Id<'deliverabilityEvidence'> | null = null;
			for (const item of DELIVERABILITY_CHECKLIST.filter(
				(entry) => entry.severity === 'blocking'
			)) {
				const scopedDomainId = item.id.startsWith('domain.') ? domainId : undefined;
				const targetKey = scopedDomainId
					? `${organizationId.length}:${organizationId}|domain:${domainId}`
					: `${organizationId.length}:${organizationId}|deployment`;
				const evidenceId = await ctx.db.insert('deliverabilityEvidence', {
					organizationId,
					itemId: item.id,
					scopeKind: scopedDomainId ? 'domain' : 'deployment',
					targetKey,
					...(scopedDomainId ? { domainId: scopedDomainId } : {}),
					attemptId: `attempt:${item.id}`,
					validator: 'test',
					status: 'pass',
					observedValues: [],
					diagnostic: 'verified',
					observedAt: now,
					createdAt: now,
				});
				if (item.id === 'deployment.ptr') ptrEvidenceId = evidenceId;
				await ctx.db.insert('deliverabilityVerificationState', {
					organizationId,
					itemId: item.id,
					targetKey,
					...(scopedDomainId ? { domainId: scopedDomainId } : {}),
					attemptId: `attempt:${item.id}`,
					generation: 1,
					retryIndex: 0,
					leaseToken: `lease:${item.id}`,
					leaseExpiresAt: now,
					currentEvidenceId: evidenceId,
					updatedAt: now,
				});
			}
			return ptrEvidenceId;
		});
		await expect(
			t.query(internal.delivery.checklistLoopbackState.getStartContext, {
				organizationId,
				domainId,
			})
		).resolves.toMatchObject({ allowed: true, domain: 'legacy.example' });
		await t.run((ctx) =>
			ctx.db.patch(ptrEvidenceId!, {
				observedAt: now - 76 * 60_000,
			})
		);
		await expect(
			t.query(internal.delivery.checklistLoopbackState.getStartContext, {
				organizationId,
				domainId,
			})
		).resolves.toMatchObject({
			allowed: false,
			reason: 'prerequisites',
			missing: expect.arrayContaining(['deployment.ptr']),
		});
	});
});
