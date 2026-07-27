/**
 * Dual-transport alignment pre-flight — state half (P3-5).
 *
 * Reads the sending domains that are due for a re-check, assembles each one's
 * two ARMS from the SHIPPED surfaces — the `domains` identity tables, the
 * `providerRoutes` transport configuration and `MTA_IP_POOLS` (no new credential
 * model, D4) — and persists the verdict the pure evaluator produced. The live
 * DNS half lives in `alignmentPreflightGather.ts` because it needs the Node
 * runtime, where Convex forbids queries and mutations.
 *
 * D2: a deployment with NO reference transport has no second arm. That is a
 * SUPPORTED CONFIGURATION — the pre-flight records `single_arm`, the gate opens,
 * and nothing anywhere renders an error or a "setup incomplete" nag.
 *
 * The one thing that is NOT allowed is to answer "no second arm" for a relay we
 * merely failed to describe: a configured relay whose signing identity we cannot
 * see records `unknown`, which HOLDS the cell at s=0.
 */

import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import {
	ALIGNMENT_SWEEP_PAGE_SIZE,
	type AlignmentArm,
	type ReferenceAlignmentArm,
	type ReferenceArmInput,
} from '@owlat/shared/deliverabilityAlignment';
import type { ReferenceArmPresence } from '@owlat/shared/deliverabilityAlignmentGate';
import { parseSpfMechanisms } from '@owlat/shared/spf';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { parsePoolIps } from '../domains/spf';
import { alignmentCheckValidator, alignmentVerdictValidator } from './deliverabilityValidators';

/** SES's SPF include, used when the relay identity carries no generated record. */
const SES_DEFAULT_SPF_MECHANISM = 'include:amazonses.com';

/**
 * Own bound for the readiness READ — a UI page size, deliberately not the cron's
 * sweep page size. Two different concerns must not share one number.
 */
const ALIGNMENT_READINESS_LIMIT = 50;

/** Upper bound on the (per-messageType) route rows we inspect for a relay. */
const PROVIDER_ROUTE_SCAN_LIMIT = 16;

export interface AlignmentTarget {
	organizationId: string;
	domain: string;
	ownArm: AlignmentArm;
	reference: ReferenceArmInput;
}

/**
 * The own MTA's SPF mechanisms, derived from the pool addresses it actually
 * sends from. NOT from `domain.dnsRecords.spf.value`: that field is optional and
 * for an SES-registered domain it holds the RELAY's include, so requiring it
 * would let the blocking SPF check pass on a relay-only record without ever
 * proving our own IPs are authorized.
 *
 * `parsePoolIps` throws on a malformed env value; an unparseable pool is "we do
 * not know our own addresses", which the pure evaluator turns into `unknown`
 * (hold) rather than a pass.
 */
function ownSpfMechanisms(): string[] {
	let poolIps: string[];
	try {
		poolIps = parsePoolIps(getOptional('MTA_IP_POOLS'));
	} catch {
		return [];
	}
	return poolIps.map((ip) => `${ip.includes(':') ? 'ip6' : 'ip4'}:${ip}`);
}

/** Relay SPF mechanisms from the identity's generated record, else SES's default. */
function relaySpfMechanisms(record: string | undefined): string[] {
	const mechanisms = parseSpfMechanisms(record ?? '');
	return mechanisms.length > 0 ? mechanisms : [SES_DEFAULT_SPF_MECHANISM];
}

/**
 * Which non-MTA transports are actually configured, from the SHIPPED surfaces:
 * every enabled `providerRoutes` entry plus the single-transport `EMAIL_PROVIDER`
 * env. The shipped transport set is wider than SES (`mta`/`ses`/`resend`/`smtp`
 * plus `plugin.*`), so answering this question from the SES identity table alone
 * would report "single arm" for a Resend/SMTP/plugin relay and let two genuinely
 * unaligned arms ramp.
 */
async function configuredRelayKinds(ctx: QueryCtx): Promise<string[]> {
	// One row per messageType — tiny by construction, and bounded anyway.
	const routes = await ctx.db.query('providerRoutes').take(PROVIDER_ROUTE_SCAN_LIMIT);
	const kinds = new Set<string>();
	for (const route of routes) {
		for (const provider of route.providers) {
			if (provider.isEnabled && provider.providerType !== 'mta') kinds.add(provider.providerType);
		}
	}
	const envProvider = getOptional('EMAIL_PROVIDER')?.trim();
	if (envProvider !== undefined && envProvider !== '' && envProvider !== 'mta') {
		kinds.add(envProvider);
	}
	return [...kinds].sort();
}

/**
 * The second arm. `none` is the standalone deployment (D2). `unknown` is a relay
 * we cannot describe — one we have no verified signing identity for, or more
 * than one at once — and it HOLDS rather than opening the gate.
 */
function referenceFor(
	domain: Doc<'domains'>,
	sesIdentity: Doc<'sendingDomainSesIdentities'> | null,
	relayKinds: readonly string[]
): ReferenceArmInput {
	if (relayKinds.length === 0) return { kind: 'none' };
	if (relayKinds.length === 1 && relayKinds[0] === 'ses' && sesIdentity !== null) {
		const arm: ReferenceAlignmentArm = {
			label: 'SES relay',
			fromDomain: domain.domain,
			dkimDomain: domain.domain,
			dkimSelectors: sesIdentity.dkimTokens,
			spfMechanisms: relaySpfMechanisms(sesIdentity.dnsRecords?.spf?.value),
			// A verified custom MAIL FROM is what lets the relay carry our own return
			// path; without it bounce attribution on that arm is coarser (P2-3).
			supportsCustomReturnPath: (sesIdentity.dnsRecords?.mailFrom?.length ?? 0) > 0,
		};
		return { kind: 'arm', arm };
	}
	return {
		kind: 'unknown',
		detail: `A relay is configured (${relayKinds.join(', ')}) but ${domain.domain} has no verified signing identity for it, so the two arms cannot be compared.`,
	};
}

/** The gate's view of the same question, without building the arms. */
function referencePresence(reference: ReferenceArmInput): ReferenceArmPresence {
	switch (reference.kind) {
		case 'none':
			return 'none';
		case 'unknown':
			return 'unknown';
		case 'arm':
			return 'configured';
	}
}

/**
 * Build one target, or null when there is no own MTA arm to compare.
 *
 * A verified domain with no `sendingDomainMtaIdentities` row is a relay-only
 * domain: it has no own-MTA selector, so there is nothing to align and nothing
 * an operator could do about a "no DKIM key published" verdict. Recording
 * `blocked` for it would manufacture a permanent, unactionable error state for a
 * supported configuration — so it is skipped and no row is written.
 */
async function buildTarget(
	ctx: QueryCtx,
	organizationId: string,
	domain: Doc<'domains'>,
	relayKinds: readonly string[]
): Promise<AlignmentTarget | null> {
	const mtaIdentity = await ctx.db
		.query('sendingDomainMtaIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.unique();
	if (mtaIdentity === null) return null;
	const sesIdentity = await ctx.db
		.query('sendingDomainSesIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.unique();
	return {
		organizationId,
		domain: domain.domain,
		ownArm: {
			label: 'own MTA',
			fromDomain: domain.domain,
			dkimDomain: domain.domain,
			dkimSelectors: [mtaIdentity.dkimSelector],
			spfMechanisms: ownSpfMechanisms(),
		},
		reference: referenceFor(domain, sesIdentity, relayKinds),
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
 * One PAGE of verified sending domains whose alignment verdict is missing or
 * due. Paginated rather than `take`-bounded: a `take(n)` prefix means domain
 * #n+1 is never a target, so its verdict is never recorded, so the gate answers
 * `not_yet_checked` forever and that domain's cells can never ramp. The caller
 * carries the cursor forward exactly like `delivery/checklistSweepState.ts`.
 */
export const listDueAlignmentTargets = internalQuery({
	args: { now: v.number(), paginationOpts: paginationOptsValidator },
	handler: async (
		ctx,
		args
	): Promise<{ targets: AlignmentTarget[]; continueCursor: string; isDone: boolean }> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const relayKinds = await configuredRelayKinds(ctx);
		const page = await ctx.db
			.query('domains')
			.withIndex('by_status', (q) => q.eq('status', 'verified'))
			.paginate({
				cursor: args.paginationOpts.cursor,
				numItems: Math.max(1, Math.min(args.paginationOpts.numItems, ALIGNMENT_SWEEP_PAGE_SIZE)),
			});
		const targets: AlignmentTarget[] = [];
		for (const domain of page.page) {
			const state = await loadAlignmentState(ctx, organizationId, domain.domain);
			if (state && state.nextCheckDueAt > args.now) continue;
			const target = await buildTarget(ctx, organizationId, domain, relayKinds);
			if (target !== null) targets.push(target);
		}
		return { targets, continueCursor: page.continueCursor, isDone: page.isDone };
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
 * The gate input the ramp controller reads: the stored verdict for a domain, or
 * null when the pre-flight has not run yet. `referenceArm` is answered from the
 * shipped transport surface, NOT from the stored row, so a standalone deployment
 * opens the gate even before the first sweep (D2) — and a relay we cannot
 * describe holds even if an older row says `aligned`.
 */
export const getAlignmentGateState = internalQuery({
	args: { domain: v.string() },
	handler: async (
		ctx,
		args
	): Promise<{
		referenceArm: ReferenceArmPresence;
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
		const relayKinds = await configuredRelayKinds(ctx);
		const reference: ReferenceArmInput =
			domain === null ? { kind: 'none' } : referenceFor(domain, sesIdentity, relayKinds);
		const state = await loadAlignmentState(ctx, organizationId, args.domain);
		return {
			referenceArm: referencePresence(reference),
			state: state ? { verdict: state.verdict, checkedAt: state.checkedAt } : null,
		};
	},
});

/**
 * Readiness-card view of the alignment pre-flight, consumed by the delivery
 * readiness panel (`apps/web/app/utils/deliveryReadiness.ts`). `single_arm` is
 * reported as a PASS with plain copy — never a warning, never a nag (D2).
 */
// all-members: non-secret DNS-facing alignment state (domain names, per-check
// pass/fail and the published-record remedy text) — the same member-visible
// floor as every other delivery readiness read; no credentials are exposed.
export const getAlignmentReadiness = authedQuery({
	args: { domain: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const domainFilter = args.domain;
		const rows = await ctx.db
			.query('deliverabilityAlignmentStates')
			.withIndex('by_org_domain', (q) => {
				const scoped = q.eq('organizationId', organizationId);
				return domainFilter === undefined ? scoped : scoped.eq('domain', domainFilter);
			})
			.take(ALIGNMENT_READINESS_LIMIT);
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
