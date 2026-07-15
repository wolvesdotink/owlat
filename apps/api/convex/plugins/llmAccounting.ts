import { parsePluginId, type PluginId } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { insertLlmUsage } from '../analytics/llmUsage';
import type { TokenUsage } from '../agent/steps/types';
import { languageEndpointProvenanceValidator } from '../lib/aiProviderConfigValidators';
import { tokenUsageValidator } from '../lib/convexValidators';
import { MAX_LLM_ATTEMPTS } from '../lib/llm/retryPolicy';
import { estimateKnownCostMicrousd } from '../lib/llm/pricing';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import {
	getBundledPluginManifest,
	requireAuthenticatedBundledPlugin,
	type HostedPluginActorScope,
} from './authorization';
import { recordHostedPluginAudit } from './audit';

const LLM_INVOKE = 'llm:invoke' as const;
const RESERVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Authorization floor before tenant provider configuration is resolved. */
export const authorize = internalQuery({
	args: { pluginId: v.string() },
	handler: async (ctx, args) => {
		await requireAuthenticatedBundledPlugin(ctx, args.pluginId, LLM_INVOKE);
		return null;
	},
});

export const reserve = internalMutation({
	args: {
		pluginId: v.string(),
		reservationId: v.string(),
		reservedMicrousd: v.number(),
		tier: v.union(v.literal('fast'), v.literal('capable')),
		modelId: v.string(),
		endpointProvenance: languageEndpointProvenanceValidator,
	},
	handler: async (ctx, args) => {
		assertReservationInput(args.reservationId, args.reservedMicrousd);
		if (
			estimateKnownCostMicrousd(args.endpointProvenance, args.modelId, {
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
			}) === undefined
		) {
			throw new Error('Plugin LLM denied');
		}
		const scope = await requireAuthenticatedBundledPlugin(ctx, args.pluginId, LLM_INVOKE);
		const dailyBudgetMicrousd = manifestBudgetMicrousd(scope.manifest.llmBudget?.dailyUsd);
		if (args.reservedMicrousd > dailyBudgetMicrousd) throw new Error('Plugin LLM denied');
		const utcDay = utcDayAt(Date.now());
		const duplicate = await reservationById(ctx, args.reservationId);
		if (duplicate) {
			if (
				duplicate.status === 'pending' &&
				duplicate.organizationId === scope.organizationId &&
				duplicate.pluginId === scope.pluginId &&
				duplicate.actorUserId === scope.userId &&
				duplicate.utcDay === utcDay &&
				duplicate.tier === args.tier &&
				duplicate.modelId === args.modelId &&
				duplicate.endpointProvenance === args.endpointProvenance &&
				duplicate.reservedMicrousd === args.reservedMicrousd
			) {
				return { reservationId: args.reservationId, utcDay };
			}
			throw new Error('Plugin LLM denied');
		}

		const daily = await dailyUsage(ctx, scope.organizationId, scope.pluginId, utcDay);
		const currentCharge = daily?.chargedMicrousd ?? 0;
		const nextCharge = currentCharge + args.reservedMicrousd;
		const admittedCallCount = (daily?.admittedCallCount ?? 0) + 1;
		if (
			!isMoney(currentCharge) ||
			!Number.isSafeInteger(nextCharge) ||
			!Number.isSafeInteger(admittedCallCount) ||
			nextCharge > dailyBudgetMicrousd
		) {
			throw new Error('Plugin LLM denied');
		}

		const now = Date.now();
		await ctx.db.insert('pluginLlmReservations', {
			organizationId: scope.organizationId,
			pluginId: scope.pluginId,
			utcDay,
			reservationId: args.reservationId,
			actorUserId: scope.userId,
			reservedMicrousd: args.reservedMicrousd,
			tier: args.tier,
			modelId: args.modelId,
			endpointProvenance: args.endpointProvenance,
			status: 'pending',
			createdAt: now,
		});
		if (daily) {
			await ctx.db.patch(daily._id, {
				chargedMicrousd: nextCharge,
				admittedCallCount,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert('pluginLlmDailyUsage', {
				organizationId: scope.organizationId,
				pluginId: scope.pluginId,
				utcDay,
				chargedMicrousd: args.reservedMicrousd,
				actualMicrousd: 0,
				admittedCallCount: 1,
				updatedAt: now,
			});
		}
		return { reservationId: args.reservationId, utcDay };
	},
});

export const settleSuccess = internalMutation({
	args: {
		reservationId: v.string(),
		modelUsed: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		attempts: v.number(),
	},
	handler: async (ctx, args) => {
		const reservation = await pendingActorReservation(ctx, args.reservationId);
		if (reservation.status === 'completed') return settlementResult(reservation);
		if (reservation.status !== 'pending') throw new Error('Plugin LLM settlement denied');
		if (
			!Number.isSafeInteger(args.attempts) ||
			args.attempts < 1 ||
			args.attempts > MAX_LLM_ATTEMPTS
		) {
			throw new Error('Plugin LLM settlement denied');
		}

		const acceptedUsage = validTokenUsage(args.tokenUsage) ? args.tokenUsage : undefined;
		const cost = successCost(reservation, args.modelUsed, acceptedUsage, args.attempts);
		const daily = await requiredDailyUsage(ctx, reservation);
		const nextDailyCharge = daily.chargedMicrousd - reservation.reservedMicrousd + cost.charged;
		const nextActual = daily.actualMicrousd + cost.actual;
		if (!isMoney(nextDailyCharge) || !isMoney(nextActual)) {
			throw new Error('Plugin LLM settlement denied');
		}
		const now = Date.now();
		await ctx.db.patch(daily._id, {
			chargedMicrousd: nextDailyCharge,
			actualMicrousd: nextActual,
			updatedAt: now,
		});
		await ctx.db.patch(reservation._id, {
			status: 'completed',
			chargedMicrousd: cost.charged,
			actualMicrousd: cost.actual,
			completedAt: now,
		});
		if (acceptedUsage && cost.isUsageAccounted) {
			await insertLlmUsage(
				ctx,
				`plugin:${reservation.pluginId}`,
				acceptedUsage,
				reservation.modelId,
				{
					organizationId: reservation.organizationId,
					pluginId: reservation.pluginId,
				}
			);
		}
		await recordHostedPluginAudit(ctx, auditScope(reservation), 'llm.generate', 'completed', {
			attempts: args.attempts,
			usageAvailable: acceptedUsage !== undefined && cost.isUsageAccounted,
			chargedMicrousd: cost.charged,
			actualMicrousd: cost.actual,
		});
		return { chargedMicrousd: cost.charged, actualMicrousd: cost.actual };
	},
});

export const settleFailure = internalMutation({
	args: { reservationId: v.string() },
	handler: async (ctx, args) => {
		const reservation = await pendingActorReservation(ctx, args.reservationId);
		if (reservation.status === 'failed') return null;
		if (reservation.status !== 'pending') throw new Error('Plugin LLM settlement denied');
		await ctx.db.patch(reservation._id, {
			status: 'failed',
			chargedMicrousd: reservation.reservedMicrousd,
			completedAt: Date.now(),
		});
		await recordHostedPluginAudit(ctx, auditScope(reservation), 'llm.generate', 'failed', {
			reasonCode: 'provider_dispatch_failed',
			chargedMicrousd: reservation.reservedMicrousd,
		});
		return null;
	},
});

export const recordDenied = internalMutation({
	args: { pluginId: v.string() },
	handler: async (ctx, args) => {
		const pluginId = parsePluginId(args.pluginId);
		getBundledPluginManifest(pluginId);
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session?.activeOrganizationId || !session.role) return null;
		await recordHostedPluginAudit(
			ctx,
			{ organizationId: session.activeOrganizationId, pluginId, userId: session.userId },
			'llm.generate',
			'denied',
			{ reasonCode: 'access_or_budget_denied' }
		);
		return null;
	},
});

function successCost(
	reservation: Doc<'pluginLlmReservations'>,
	modelUsed: string | undefined,
	usage: TokenUsage | undefined,
	attempts: number
): { charged: number; actual: number; isUsageAccounted: boolean } {
	const perAttempt = reservation.reservedMicrousd / MAX_LLM_ATTEMPTS;
	if (!Number.isSafeInteger(perAttempt) || perAttempt < 1 || !usage) {
		return { charged: reservation.reservedMicrousd, actual: 0, isUsageAccounted: false };
	}
	if (modelUsed !== reservation.modelId) {
		return { charged: reservation.reservedMicrousd, actual: 0, isUsageAccounted: false };
	}
	const actual = estimateKnownCostMicrousd(
		reservation.endpointProvenance,
		reservation.modelId,
		usage
	);
	if (actual === undefined || actual > perAttempt) {
		return { charged: reservation.reservedMicrousd, actual: 0, isUsageAccounted: false };
	}
	return { charged: (attempts - 1) * perAttempt + actual, actual, isUsageAccounted: true };
}

async function pendingActorReservation(ctx: MutationCtx, reservationId: string) {
	if (!RESERVATION_ID.test(reservationId)) throw new Error('Plugin LLM settlement denied');
	const reservation = await reservationById(ctx, reservationId);
	if (!reservation) throw new Error('Plugin LLM settlement denied');
	const session = await getBetterAuthSessionWithRole(ctx);
	if (
		!session?.activeOrganizationId ||
		!session.role ||
		session.activeOrganizationId !== reservation.organizationId ||
		session.userId !== reservation.actorUserId
	) {
		throw new Error('Plugin LLM settlement denied');
	}
	return reservation;
}

function auditScope(row: Doc<'pluginLlmReservations'>): HostedPluginActorScope {
	return {
		organizationId: row.organizationId,
		pluginId: parsePluginId(row.pluginId),
		userId: row.actorUserId,
	};
}

function settlementResult(row: Doc<'pluginLlmReservations'>) {
	return {
		chargedMicrousd: row.chargedMicrousd ?? row.reservedMicrousd,
		actualMicrousd: row.actualMicrousd ?? 0,
	};
}

function manifestBudgetMicrousd(dailyUsd: number | undefined): number {
	const value = (dailyUsd ?? 0) * 1_000_000;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error('Plugin LLM denied');
	return value;
}

function assertReservationInput(id: string, amount: number): void {
	if (
		!RESERVATION_ID.test(id) ||
		!isMoney(amount) ||
		amount < MAX_LLM_ATTEMPTS ||
		amount % MAX_LLM_ATTEMPTS !== 0
	) {
		throw new Error('Plugin LLM denied');
	}
}

function isMoney(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function validTokenUsage(value: TokenUsage | undefined): value is TokenUsage {
	return (
		value !== undefined &&
		isMoney(value.promptTokens) &&
		isMoney(value.completionTokens) &&
		isMoney(value.totalTokens) &&
		value.totalTokens >= value.promptTokens + value.completionTokens
	);
}

function utcDayAt(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function reservationById(ctx: MutationCtx, reservationId: string) {
	return ctx.db
		.query('pluginLlmReservations')
		.withIndex('by_reservation_id', (query) => query.eq('reservationId', reservationId))
		.unique();
}

function dailyUsage(ctx: MutationCtx, organizationId: string, pluginId: PluginId, utcDay: string) {
	return ctx.db
		.query('pluginLlmDailyUsage')
		.withIndex('by_organization_id_and_plugin_id_and_utc_day', (query) =>
			query.eq('organizationId', organizationId).eq('pluginId', pluginId).eq('utcDay', utcDay)
		)
		.unique();
}

async function requiredDailyUsage(ctx: MutationCtx, row: Doc<'pluginLlmReservations'>) {
	const daily = await dailyUsage(ctx, row.organizationId, parsePluginId(row.pluginId), row.utcDay);
	if (!daily || !isMoney(daily.chargedMicrousd) || !isMoney(daily.actualMicrousd)) {
		throw new Error('Plugin LLM settlement denied');
	}
	return daily;
}
