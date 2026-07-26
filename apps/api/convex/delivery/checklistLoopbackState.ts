import { v } from 'convex/values';
import { DELIVERABILITY_CHECKLIST, type DeliverabilityCheckId } from '@owlat/shared';
import { parseIpAddress } from '@owlat/shared/ipAddress';
import { isDnsLabel } from '@owlat/shared/dnsZone';
import { isFqdn } from '@owlat/shared/fcrdns';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import { deliverabilityTargetKey } from './checklistEvidence';

const EVIDENCE_LIMIT = 1_500;

type LoopbackAttemptStatus = 'sending' | 'awaiting_inbound' | 'passed' | 'failed' | 'timed_out';
type LoopbackStartContext =
	| { allowed: true; domain: string }
	| {
			allowed: false;
			reason: 'domain_not_found' | 'mta_unavailable' | 'prerequisites';
			missing?: DeliverabilityCheckId[];
	  };
type LoopbackMutationStatus = LoopbackAttemptStatus | 'missing';
type InboundEvidenceResult = {
	recorded: boolean;
	status?: 'passed' | 'failed';
};

export function isModernTlsProtocol(value: string): boolean {
	return value === 'TLSv1.2' || value === 'TLSv1.3';
}

function isDkimSelector(value: string | undefined): value is string {
	return (
		value !== undefined &&
		value.length <= 128 &&
		value.split('.').every((label) => isDnsLabel(label))
	);
}

export function loopbackTimeoutPatch(
	attemptId: Id<'deliverabilityLoopbackAttempts'>,
	completedAt: number
): {
	status: 'timed_out';
	detail: string;
	completedAt: number;
	correlationTokenHash: string;
} {
	return {
		status: 'timed_out' as const,
		detail: 'No authenticated inbound observation arrived before the probe expired.',
		completedAt,
		correlationTokenHash: `expired:${attemptId}`,
	};
}

async function currentStatus(
	ctx: QueryCtx,
	organizationId: string,
	itemId: DeliverabilityCheckId,
	domainId?: Parameters<typeof deliverabilityTargetKey>[1]
): Promise<Doc<'deliverabilityEvidence'> | null> {
	const targetKey = deliverabilityTargetKey(organizationId, domainId);
	const state = await ctx.db
		.query('deliverabilityVerificationState')
		.withIndex('by_org_target_item', (q) =>
			q.eq('organizationId', organizationId).eq('targetKey', targetKey).eq('itemId', itemId)
		)
		.unique();
	if (!state?.currentEvidenceId) return null;
	return await ctx.db.get(state.currentEvidenceId);
}

export const getStartContext = internalQuery({
	args: { organizationId: v.string(), domainId: v.id('domains') },
	handler: async (ctx, args): Promise<LoopbackStartContext> => {
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return { allowed: false as const, reason: 'domain_not_found' as const };
		if (domain.providerType !== 'mta') {
			return { allowed: false as const, reason: 'mta_unavailable' as const };
		}
		const required = DELIVERABILITY_CHECKLIST.filter((item) => item.severity === 'blocking');
		if (required.length > EVIDENCE_LIMIT) {
			throw new Error('Deliverability prerequisite catalog exceeds its bounded read limit');
		}
		const evidence = await Promise.all(
			required.map((item) =>
				currentStatus(
					ctx,
					args.organizationId,
					item.id,
					item.id.startsWith('domain.') ? args.domainId : undefined
				)
			)
		);
		const missing = required
			.filter((_item, index) => evidence[index]?.status !== 'pass')
			.map((item) => item.id);
		return missing.length === 0
			? {
					allowed: true as const,
					domain: domain.domain,
				}
			: { allowed: false as const, reason: 'prerequisites' as const, missing };
	},
});

export const create = internalMutation({
	args: {
		organizationId: v.string(),
		attemptId: v.string(),
		domainId: v.id('domains'),
		domain: v.string(),
		correlationTokenHash: v.string(),
		startedAt: v.number(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args): Promise<{ created: boolean; status: LoopbackAttemptStatus }> => {
		const latest = await ctx.db
			.query('deliverabilityLoopbackAttempts')
			.withIndex('by_org_domain_started', (q) =>
				q.eq('organizationId', args.organizationId).eq('domainId', args.domainId)
			)
			.order('desc')
			.first();
		if (
			latest &&
			(latest.status === 'sending' || latest.status === 'awaiting_inbound') &&
			latest.expiresAt > args.startedAt
		) {
			return { created: false as const, status: latest.status };
		}
		await ctx.db.insert('deliverabilityLoopbackAttempts', {
			...args,
			status: 'sending',
		});
		await ctx.scheduler.runAt(args.expiresAt, internal.delivery.checklistLoopbackState.expire, {
			organizationId: args.organizationId,
			attemptId: args.attemptId,
		});
		return { created: true as const, status: 'sending' as const };
	},
});

export const markAccepted = internalMutation({
	args: {
		organizationId: v.string(),
		attemptId: v.string(),
		providerMessageId: v.string(),
	},
	handler: async (ctx, args): Promise<LoopbackMutationStatus> => {
		const row = await ctx.db
			.query('deliverabilityLoopbackAttempts')
			.withIndex('by_org_attempt', (q) =>
				q.eq('organizationId', args.organizationId).eq('attemptId', args.attemptId)
			)
			.unique();
		if (!row) return 'missing' as const;
		if (row.status !== 'sending') return row.status;
		await ctx.db.patch(row._id, {
			status: 'awaiting_inbound',
			providerMessageId: args.providerMessageId.slice(0, 512),
		});
		return 'awaiting_inbound' as const;
	},
});

export const markSendFailed = internalMutation({
	args: {
		organizationId: v.string(),
		attemptId: v.string(),
		detail: v.string(),
		now: v.number(),
	},
	handler: async (ctx, args): Promise<LoopbackMutationStatus> => {
		const row = await ctx.db
			.query('deliverabilityLoopbackAttempts')
			.withIndex('by_org_attempt', (q) =>
				q.eq('organizationId', args.organizationId).eq('attemptId', args.attemptId)
			)
			.unique();
		if (!row) return 'missing' as const;
		if (row.status !== 'sending') return row.status;
		await ctx.db.patch(row._id, {
			status: 'failed',
			detail: args.detail.slice(0, 2_048),
			completedAt: args.now,
		});
		return 'failed' as const;
	},
});

const authResult = v.union(v.literal('pass'), v.literal('fail'), v.literal('unknown'));

export const recordInboundEvidence = internalMutation({
	args: {
		correlationTokenHash: v.string(),
		spf: authResult,
		dkim: authResult,
		dmarc: authResult,
		dkimSelector: v.optional(v.string()),
		tlsVersion: v.string(),
		sendingIp: v.string(),
		ptr: v.string(),
		detail: v.optional(v.string()),
		now: v.number(),
	},
	handler: async (ctx, args): Promise<InboundEvidenceResult> => {
		const row = await ctx.db
			.query('deliverabilityLoopbackAttempts')
			.withIndex('by_token_hash', (q) => q.eq('correlationTokenHash', args.correlationTokenHash))
			.unique();
		if (
			!row ||
			(row.status !== 'sending' && row.status !== 'awaiting_inbound') ||
			row.expiresAt < args.now
		) {
			return { recorded: false as const };
		}
		const passed =
			args.spf === 'pass' &&
			args.dkim === 'pass' &&
			args.dmarc === 'pass' &&
			isDkimSelector(args.dkimSelector) &&
			isModernTlsProtocol(args.tlsVersion) &&
			parseIpAddress(args.sendingIp) !== null &&
			isFqdn(args.ptr);
		await ctx.db.patch(row._id, {
			status: passed ? 'passed' : 'failed',
			spf: args.spf,
			dkim: args.dkim,
			dmarc: args.dmarc,
			...(args.dkimSelector ? { dkimSelector: args.dkimSelector.slice(0, 128) } : {}),
			tlsVersion: args.tlsVersion.slice(0, 64),
			sendingIp: args.sendingIp.slice(0, 128),
			ptr: args.ptr.slice(0, 512),
			detail: (
				args.detail ??
				(passed
					? 'Inbound authentication and transport evidence passed.'
					: 'Inbound authentication evidence did not pass.')
			).slice(0, 2_048),
			completedAt: args.now,
			// Enforce single use even if a future status transition is added.
			correlationTokenHash: `consumed:${row._id}`,
		});
		return { recorded: true as const, status: passed ? ('passed' as const) : ('failed' as const) };
	},
});

export const expire = internalMutation({
	args: { organizationId: v.string(), attemptId: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const row = await ctx.db
			.query('deliverabilityLoopbackAttempts')
			.withIndex('by_org_attempt', (q) =>
				q.eq('organizationId', args.organizationId).eq('attemptId', args.attemptId)
			)
			.unique();
		if (
			!row ||
			(row.status !== 'sending' && row.status !== 'awaiting_inbound') ||
			row.expiresAt > Date.now()
		) {
			return false;
		}
		await ctx.db.patch(row._id, loopbackTimeoutPatch(row._id, Date.now()));
		return true;
	},
});
