/**
 * Dual-transport alignment pre-flight — state half (P3-5).
 *
 * Reads the sending domains that are due for a re-check, assembles each one's
 * two ARMS from the SHIPPED identity tables (`domains` + the per-provider
 * `sendingDomain*Identities` rows — no new credential model, D4), and persists
 * the verdict the pure evaluator produced. The live DNS half lives in
 * `alignmentPreflightGather.ts` because it needs the Node runtime, where Convex
 * forbids queries and mutations.
 *
 * D2: a domain with NO reference-transport identity has no second arm. That is
 * a SUPPORTED CONFIGURATION — the pre-flight records `single_arm`, the gate
 * opens, and nothing anywhere renders an error or a "setup incomplete" nag.
 */

import { v } from 'convex/values';
import { parseSpfMechanisms } from '@owlat/shared/spf';
import type { AlignmentArm } from '@owlat/shared/deliverabilityAlignment';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { alignmentCheckValidator, alignmentVerdictValidator } from './deliverabilityValidators';

/** Upper bound on domains re-checked per sweep, so the daily cron stays bounded. */
export const ALIGNMENT_SWEEP_LIMIT = 25;

/** SES's SPF include, used when the relay identity carries no generated record. */
const SES_DEFAULT_SPF_MECHANISM = 'include:amazonses.com';

export interface AlignmentTarget {
	organizationId: string;
	domain: string;
	ownArm: AlignmentArm;
	referenceArm: AlignmentArm | null;
}

function mechanismsOf(record: string | undefined, fallback: readonly string[]): string[] {
	const mechanisms = parseSpfMechanisms(record ?? '');
	return mechanisms.length > 0 ? mechanisms : [...fallback];
}

function ownArmFor(
	domain: Doc<'domains'>,
	identity: Doc<'sendingDomainMtaIdentities'> | null
): AlignmentArm {
	return {
		label: 'own MTA',
		fromDomain: domain.domain,
		dkimDomain: domain.domain,
		dkimSelectors: identity ? [identity.dkimSelector] : [],
		spfMechanisms: mechanismsOf(domain.dnsRecords.spf?.value, []),
		// The own MTA always stamps our VERP return path.
		supportsCustomReturnPath: true,
	};
}

/**
 * The reference arm, or null when no relay identity exists. Absence is the
 * standalone deployment, not a misconfiguration.
 */
function referenceArmFor(
	domain: Doc<'domains'>,
	identity: Doc<'sendingDomainSesIdentities'> | null
): AlignmentArm | null {
	if (!identity) return null;
	return {
		label: 'SES relay',
		fromDomain: domain.domain,
		dkimDomain: domain.domain,
		dkimSelectors: identity.dkimTokens,
		spfMechanisms: mechanismsOf(identity.dnsRecords?.spf?.value, [SES_DEFAULT_SPF_MECHANISM]),
		// A verified custom MAIL FROM is what lets the relay carry our own return
		// path; without it bounce attribution on that arm is coarser (P2-3).
		supportsCustomReturnPath: (identity.dnsRecords?.mailFrom?.length ?? 0) > 0,
	};
}

async function buildTarget(
	ctx: QueryCtx,
	organizationId: string,
	domain: Doc<'domains'>
): Promise<AlignmentTarget> {
	const mtaIdentity = await ctx.db
		.query('sendingDomainMtaIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.unique();
	const sesIdentity = await ctx.db
		.query('sendingDomainSesIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.unique();
	return {
		organizationId,
		domain: domain.domain,
		ownArm: ownArmFor(domain, mtaIdentity),
		referenceArm: referenceArmFor(domain, sesIdentity),
	};
}

async function loadAlignmentState(
	ctx: QueryCtx,
	organizationId: string,
	domain: string
): Promise<Doc<'deliverabilityAlignmentStates'> | null> {
	return await ctx.db
		.query('deliverabilityAlignmentStates')
		.withIndex('by_org_domain', (q) => q.eq('organizationId', organizationId).eq('domain', domain))
		.unique();
}

/**
 * Verified sending domains whose alignment verdict is missing or due, oldest
 * due first. Bounded by `limit` so a deployment with many domains re-checks in
 * bounded slices rather than in one unbounded scan.
 */
export const listDueAlignmentTargets = internalQuery({
	args: { now: v.number(), limit: v.optional(v.number()) },
	handler: async (ctx, args): Promise<AlignmentTarget[]> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const limit = Math.max(1, Math.min(args.limit ?? ALIGNMENT_SWEEP_LIMIT, ALIGNMENT_SWEEP_LIMIT));
		const domains = await ctx.db
			.query('domains')
			.withIndex('by_status', (q) => q.eq('status', 'verified'))
			.take(limit * 4);
		const targets: AlignmentTarget[] = [];
		for (const domain of domains) {
			if (targets.length >= limit) break;
			const state = await loadAlignmentState(ctx, organizationId, domain.domain);
			if (state && state.nextCheckDueAt > args.now) continue;
			targets.push(await buildTarget(ctx, organizationId, domain));
		}
		return targets;
	},
});

/** Persist one pre-flight verdict. Idempotent per (organization, domain). */
export const recordAlignmentResult = internalMutation({
	args: {
		domain: v.string(),
		verdict: alignmentVerdictValidator,
		checks: v.array(alignmentCheckValidator),
		degradedMeasurement: v.boolean(),
		degradedMeasurementReason: v.optional(v.string()),
		checkedAt: v.number(),
		nextCheckDueAt: v.number(),
	},
	handler: async (ctx, args) => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const existing = await loadAlignmentState(ctx, organizationId, args.domain);
		const row = {
			organizationId,
			domain: args.domain,
			verdict: args.verdict,
			checks: args.checks,
			degradedMeasurement: args.degradedMeasurement,
			degradedMeasurementReason: args.degradedMeasurementReason,
			checkedAt: args.checkedAt,
			nextCheckDueAt: args.nextCheckDueAt,
			updatedAt: args.checkedAt,
		};
		if (existing) {
			// A stale result must never overwrite a fresher one (out-of-order sweeps).
			if (existing.checkedAt > args.checkedAt) return;
			await ctx.db.patch(existing._id, row);
			return;
		}
		await ctx.db.insert('deliverabilityAlignmentStates', row);
	},
});

/**
 * The gate input the ramp controller reads: the stored verdict for a domain,
 * or null when the pre-flight has not run yet. `hasReferenceArm` is answered
 * from the identity tables, NOT from the stored row, so a standalone
 * deployment opens the gate even before the first sweep (D2).
 */
export const getAlignmentGateState = internalQuery({
	args: { domain: v.string() },
	handler: async (
		ctx,
		args
	): Promise<{
		hasReferenceArm: boolean;
		state: { verdict: Doc<'deliverabilityAlignmentStates'>['verdict']; checkedAt: number } | null;
	}> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const domain = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', args.domain))
			.unique();
		const sesIdentity = domain
			? await ctx.db
					.query('sendingDomainSesIdentities')
					.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
					.unique()
			: null;
		const state = await loadAlignmentState(ctx, organizationId, args.domain);
		return {
			hasReferenceArm: sesIdentity !== null,
			state: state ? { verdict: state.verdict, checkedAt: state.checkedAt } : null,
		};
	},
});

/**
 * Readiness-card view of the alignment pre-flight. `single_arm` is reported as
 * a PASS with plain copy — never a warning, never a nag.
 *
 * authz: `authedQuery` — the same floor as every other delivery readiness read.
 */
export const getAlignmentReadiness = authedQuery({
	args: { domain: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const domainFilter = args.domain;
		const rows =
			domainFilter === undefined
				? await ctx.db
						.query('deliverabilityAlignmentStates')
						.withIndex('by_org_domain', (q) => q.eq('organizationId', organizationId))
						.take(ALIGNMENT_SWEEP_LIMIT)
				: await ctx.db
						.query('deliverabilityAlignmentStates')
						.withIndex('by_org_domain', (q) =>
							q.eq('organizationId', organizationId).eq('domain', domainFilter)
						)
						.take(ALIGNMENT_SWEEP_LIMIT);
		return rows.map((row) => ({
			domain: row.domain,
			verdict: row.verdict,
			checks: row.checks,
			degradedMeasurement: row.degradedMeasurement,
			degradedMeasurementReason: row.degradedMeasurementReason ?? null,
			checkedAt: row.checkedAt,
			nextCheckDueAt: row.nextCheckDueAt,
		}));
	},
});
