import { v, type Validator } from 'convex/values';
import {
	DELIVERABILITY_CHECKLIST,
	DELIVERABILITY_CHECKLIST_STATUSES,
	DELIVERABILITY_DIAGNOSTIC_LENGTH,
	DELIVERABILITY_OBSERVED_VALUE_LENGTH,
	DELIVERABILITY_OBSERVED_VALUE_LIMIT,
	sanitizeDeliverabilityText,
	type DeliverabilityCheckId,
	type DeliverabilityChecklistStatus,
} from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { checklistTraits } from './checklistTraits';

const LEASE_MS = 2 * 60_000;
export const DNS_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export function nextDnsRetry(
	retryIndex: number,
	status: DeliverabilityChecklistStatus,
	isDnsBacked: boolean,
	validator?: string
): { delayMs: number; retryIndex: number } | null {
	const retryableDns = status === 'pending-dns' && isDnsBacked;
	const retryableValidator = status === 'warn' && validator === 'checklist.orchestrator';
	if (!retryableDns && !retryableValidator) return null;
	if (retryIndex >= DNS_RETRY_DELAYS_MS.length) return null;
	const delayIndex = Math.max(0, Math.min(retryIndex, DNS_RETRY_DELAYS_MS.length - 1));
	return {
		delayMs: DNS_RETRY_DELAYS_MS[delayIndex]!,
		retryIndex: Math.min(retryIndex + 1, DNS_RETRY_DELAYS_MS.length),
	};
}

function literalUnion<const T extends readonly [string, ...string[]]>(values: T) {
	const [first, ...rest] = values;
	return v.union(v.literal(first), ...rest.map((value) => v.literal(value))) as Validator<
		T[number]
	>;
}

export const deliverabilityCheckIdValidator = literalUnion(
	DELIVERABILITY_CHECKLIST.map((item) => item.id) as [
		DeliverabilityCheckId,
		...DeliverabilityCheckId[],
	]
);
export const deliverabilityStatusValidator = literalUnion(DELIVERABILITY_CHECKLIST_STATUSES);

export function deliverabilityTargetKey(organizationId: string, domainId?: Id<'domains'>): string {
	return domainId
		? `${organizationId.length}:${organizationId}|domain:${domainId}`
		: `${organizationId.length}:${organizationId}|deployment`;
}

function boundedDiagnostic(value: string): string {
	return sanitizeDeliverabilityText(value).slice(0, DELIVERABILITY_DIAGNOSTIC_LENGTH);
}

export function boundedObservedValues(values: readonly string[]): string[] {
	const truncated =
		values.length > DELIVERABILITY_OBSERVED_VALUE_LIMIT
			? values.length - (DELIVERABILITY_OBSERVED_VALUE_LIMIT - 1)
			: 0;
	const retained =
		truncated > 0 ? values.slice(0, DELIVERABILITY_OBSERVED_VALUE_LIMIT - 1) : values;
	const bounded = retained.map((value) =>
		boundedDiagnostic(value).slice(0, DELIVERABILITY_OBSERVED_VALUE_LENGTH)
	);
	return truncated > 0 ? [...bounded, `truncated-observations=${truncated}`] : bounded;
}

export const claimVerification = internalMutation({
	args: {
		organizationId: v.string(),
		itemId: deliverabilityCheckIdValidator,
		domainId: v.optional(v.id('domains')),
		attemptId: v.string(),
		leaseToken: v.string(),
		now: v.number(),
		expectedGeneration: v.optional(v.number()),
		preserveScheduledRetry: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === args.itemId);
		if (!definition) throw new Error('Unknown deliverability checklist item');
		if ((checklistTraits(definition.id).scope === 'domain') !== Boolean(args.domainId)) {
			throw new Error('Checklist scope does not match the requested target');
		}
		if (args.domainId && !(await ctx.db.get(args.domainId))) {
			throw new Error('Sending domain not found');
		}

		const targetKey = deliverabilityTargetKey(args.organizationId, args.domainId);
		const existing = await ctx.db
			.query('deliverabilityVerificationState')
			.withIndex('by_org_target_item', (q) =>
				q
					.eq('organizationId', args.organizationId)
					.eq('targetKey', targetKey)
					.eq('itemId', args.itemId)
			)
			.unique();
		if (
			args.expectedGeneration === undefined &&
			args.preserveScheduledRetry === true &&
			existing?.nextCheckAt !== undefined
		) {
			return {
				claimed: false as const,
				reason: 'scheduled_retry' as const,
				nextCheckAt: existing.nextCheckAt,
			};
		}
		if (args.expectedGeneration !== undefined) {
			if (
				!existing ||
				existing.generation !== args.expectedGeneration ||
				existing.nextCheckAt === undefined ||
				existing.nextCheckAt > args.now
			) {
				return { claimed: false as const, reason: 'stale_retry' as const };
			}
			if (existing.leaseExpiresAt > args.now) {
				return {
					claimed: false as const,
					attemptId: existing.attemptId,
					nextCheckAt: existing.nextCheckAt,
				};
			}
			await ctx.db.patch(existing._id, {
				attemptId: args.attemptId,
				leaseToken: args.leaseToken,
				leaseExpiresAt: args.now + LEASE_MS,
				nextCheckAt: undefined,
				updatedAt: args.now,
			});
			return {
				claimed: true as const,
				generation: existing.generation,
				targetKey,
				retryIndex: existing.retryIndex,
			};
		}
		if (existing && existing.leaseExpiresAt > args.now) {
			return {
				claimed: false as const,
				attemptId: existing.attemptId,
				nextCheckAt: existing.nextCheckAt,
			};
		}
		const generation = (existing?.generation ?? 0) + 1;
		const state = {
			organizationId: args.organizationId,
			itemId: args.itemId,
			targetKey,
			...(args.domainId ? { domainId: args.domainId } : {}),
			attemptId: args.attemptId,
			generation,
			retryIndex: 0,
			nextCheckAt: undefined,
			leaseToken: args.leaseToken,
			leaseExpiresAt: args.now + LEASE_MS,
			...(existing?.currentEvidenceId ? { currentEvidenceId: existing.currentEvidenceId } : {}),
			updatedAt: args.now,
		};
		if (existing) await ctx.db.replace(existing._id, state);
		else await ctx.db.insert('deliverabilityVerificationState', state);
		return {
			claimed: true as const,
			generation,
			targetKey,
			retryIndex: 0,
		};
	},
});

interface RecordEvidenceArgs {
	organizationId: string;
	itemId: DeliverabilityCheckId;
	domainId?: Id<'domains'>;
	attemptId: string;
	generation: number;
	leaseToken: string;
	validator: string;
	status: DeliverabilityChecklistStatus;
	observedValues: string[];
	diagnostic: string;
	observedAt: number;
}

async function insertRegressionAlert(
	ctx: MutationCtx,
	args: RecordEvidenceArgs,
	targetKey: string,
	previousEvidenceId: Id<'deliverabilityEvidence'>,
	regressedEvidenceId: Id<'deliverabilityEvidence'>
): Promise<void> {
	const identity = `${targetKey.length}:${targetKey}|${args.itemId}|${previousEvidenceId}`;
	const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === args.itemId);
	const existing = await ctx.db
		.query('deliverabilityRegressionAlerts')
		.withIndex('by_org_identity', (q) =>
			q.eq('organizationId', args.organizationId).eq('identity', identity)
		)
		.unique();
	if (existing) return;
	await ctx.db.insert('deliverabilityRegressionAlerts', {
		organizationId: args.organizationId,
		identity,
		itemId: args.itemId,
		targetKey,
		...(args.domainId ? { domainId: args.domainId } : {}),
		previousEvidenceId,
		regressedEvidenceId,
		observedAt: args.observedAt,
		message: boundedDiagnostic(
			`${definition?.title ?? 'A deliverability check'} regressed after a confirmed pass: ${args.diagnostic}`
		),
		emailNotificationState: 'pending',
		createdAt: args.observedAt,
	});
	await ctx.scheduler.runAfter(0, internal.delivery.checklistAlerts.deliverRegressionEmail, {
		identity,
		organizationId: args.organizationId,
	});
}

async function resolveRecoveredAlerts(
	ctx: MutationCtx,
	organizationId: string,
	targetKey: string,
	itemId: DeliverabilityCheckId,
	resolvedAt: number
): Promise<void> {
	const alerts = await ctx.db
		.query('deliverabilityRegressionAlerts')
		.withIndex('by_org_target_item_resolved', (q) =>
			q
				.eq('organizationId', organizationId)
				.eq('targetKey', targetKey)
				.eq('itemId', itemId)
				.eq('resolvedAt', undefined)
		)
		.take(50);
	for (const alert of alerts) {
		await ctx.db.patch(alert._id, { resolvedAt });
	}
}

export const recordEvidence = internalMutation({
	args: {
		organizationId: v.string(),
		itemId: deliverabilityCheckIdValidator,
		domainId: v.optional(v.id('domains')),
		attemptId: v.string(),
		generation: v.number(),
		leaseToken: v.string(),
		validator: v.string(),
		status: deliverabilityStatusValidator,
		observedValues: v.array(v.string()),
		diagnostic: v.string(),
		observedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const targetKey = deliverabilityTargetKey(args.organizationId, args.domainId);
		const state = await ctx.db
			.query('deliverabilityVerificationState')
			.withIndex('by_org_target_item', (q) =>
				q
					.eq('organizationId', args.organizationId)
					.eq('targetKey', targetKey)
					.eq('itemId', args.itemId)
			)
			.unique();
		if (
			!state ||
			state.attemptId !== args.attemptId ||
			state.generation !== args.generation ||
			state.leaseToken !== args.leaseToken ||
			state.leaseExpiresAt < args.observedAt
		) {
			return { recorded: false as const, reason: 'stale_attempt' as const };
		}

		const duplicate = await ctx.db
			.query('deliverabilityEvidence')
			.withIndex('by_org_attempt', (q) =>
				q.eq('organizationId', args.organizationId).eq('attemptId', args.attemptId)
			)
			.unique();
		if (duplicate) {
			return { recorded: false as const, reason: 'duplicate_attempt' as const };
		}
		const lastConfirmedPass = await ctx.db
			.query('deliverabilityEvidence')
			.withIndex('by_org_target_item_status_observed', (q) =>
				q
					.eq('organizationId', args.organizationId)
					.eq('targetKey', targetKey)
					.eq('itemId', args.itemId)
					.eq('status', 'pass')
			)
			.order('desc')
			.first();
		const evidenceId = await ctx.db.insert('deliverabilityEvidence', {
			organizationId: args.organizationId,
			itemId: args.itemId,
			scopeKind: args.domainId ? 'domain' : 'deployment',
			targetKey,
			...(args.domainId ? { domainId: args.domainId } : {}),
			attemptId: args.attemptId,
			validator: boundedDiagnostic(args.validator).slice(0, 128),
			status: args.status,
			observedValues: boundedObservedValues(args.observedValues),
			diagnostic: boundedDiagnostic(args.diagnostic),
			observedAt: args.observedAt,
			createdAt: args.observedAt,
		});

		if (
			lastConfirmedPass &&
			(args.status === 'fail' || args.status === 'warn') &&
			args.validator !== 'checklist.orchestrator'
		) {
			await insertRegressionAlert(ctx, args, targetKey, lastConfirmedPass._id, evidenceId);
		}
		if (args.status === 'pass') {
			await resolveRecoveredAlerts(
				ctx,
				args.organizationId,
				targetKey,
				args.itemId,
				args.observedAt
			);
		}

		const definition = DELIVERABILITY_CHECKLIST.find((item) => item.id === args.itemId)!;
		const retry = nextDnsRetry(state.retryIndex, args.status, definition.dnsBacked, args.validator);
		const nextCheckAt = retry ? args.observedAt + retry.delayMs : undefined;
		await ctx.db.patch(state._id, {
			retryIndex: retry?.retryIndex ?? 0,
			nextCheckAt,
			leaseExpiresAt: args.observedAt,
			currentEvidenceId: evidenceId,
			updatedAt: args.observedAt,
		});
		if (nextCheckAt !== undefined) {
			await ctx.scheduler.runAt(nextCheckAt, internal.delivery.checklistVerification.retry, {
				organizationId: args.organizationId,
				itemId: args.itemId,
				...(args.domainId ? { domainId: args.domainId } : {}),
				expectedGeneration: args.generation,
			});
		}
		return { recorded: true as const, evidenceId, nextCheckAt };
	},
});
