/**
 * Custom Tracking Domains
 *
 * Allows organizations to use their own branded domains for click/open tracking.
 * Prevents reputation cross-contamination between tenants.
 *
 * A domain is verified by `trackingDomainCheck.checkTrackingDomain` (CNAME plus
 * HTTPS probe) and re-checked daily; `trackingDomainVerdict.ts` holds the rules.
 */

import { v } from 'convex/values';
import { internalQuery, internalAction } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { isValidDomain } from '@owlat/shared';
import { getOrThrow, throwAlreadyExists, throwInvalidInput } from '../_utils/errors';
import { getOptional } from '../lib/env';
import { recordAuditLog } from '../lib/auditLog';
import { trackingDomainCheckOutcomeValidator } from '../lib/literalValidators';
import { planTrackingDomainCheck, selectTrackingDomainForSender } from './trackingDomainVerdict';

/**
 * The host a branded tracking subdomain must CNAME at.
 *
 * Open/click tracking is served by the `/t/o` and `/t/c` HTTP actions
 * (delivery/trackingHttp.ts, routed in http.ts), which live on THIS
 * deployment's own Convex site — reached via CONVEX_SITE_URL, the same host
 * the campaign send path uses as the default `trackingBaseUrl`
 * (delivery/worker.ts). A self-hosted instance does not own or serve the
 * old SaaS host `track.owlat.com`, so the CNAME target must point at the
 * deployment's own tracking host or DNS verification can never legitimately
 * pass (and any link rewritten to it would off-route to a host the operator
 * doesn't run).
 *
 * We therefore derive the target from CONVEX_SITE_URL's hostname. If it's
 * unset (e.g. in tests), fall back to a clearly-non-routable placeholder so
 * nothing silently points at an external SaaS host.
 */
function resolveCnameTarget(): string {
	const convexSiteUrl = getOptional('CONVEX_SITE_URL');
	if (convexSiteUrl) {
		try {
			return new URL(convexSiteUrl).hostname.toLowerCase();
		} catch {
			// Malformed CONVEX_SITE_URL — fall through to placeholder.
		}
	}
	return 'tracking-host-not-configured.invalid';
}

// Add tracking domain for an org
export const addTrackingDomain = authedMutation({
	args: {
		domain: v.string(),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can perform this action'
		);

		// The name becomes the host of every tracked link and of the HTTPS probe,
		// so nothing but a hostname (no port, path or userinfo) is accepted.
		const domain = args.domain.trim().toLowerCase();
		if (!isValidDomain(domain)) throwInvalidInput('Enter a domain name such as track.example.com');

		// Ensure domain is not already registered
		const existing = await ctx.db
			.query('trackingDomains')
			.withIndex('by_domain', (q) => q.eq('domain', domain))
			.first();

		if (existing) {
			throwAlreadyExists('This domain is already registered');
		}

		// CNAME target = this deployment's own tracking host (CONVEX_SITE_URL),
		// where the /t/o and /t/c handlers are actually served — never a SaaS host.
		const cnameTarget = resolveCnameTarget();

		return await ctx.db.insert('trackingDomains', {
			domain,
			cnameTarget,
			isVerified: false,
			verifiedAt: undefined,
			createdAt: Date.now(),
		});
	},
});

// Verify a tracking domain — schedules the CNAME + HTTPS check
export const verifyTrackingDomain = authedMutation({
	args: {
		trackingDomainId: v.id('trackingDomains'),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can perform this action'
		);

		await getOrThrow(ctx, args.trackingDomainId, 'Tracking domain');
		await ctx.scheduler.runAfter(0, internal.domains.trackingDomainCheck.checkTrackingDomain, {
			trackingDomainId: args.trackingDomainId,
		});

		// Return a truthy sentinel (mirrors `dnsVerification.verifyDomain`) so the
		// caller's Operation module can distinguish success from a caught failure
		// (run() resolves to `undefined` on error). Without this the FE success UX
		// — auto-expanding the row and toasting — never fires.
		return { success: true };
	},
});

// List tracking domains for org
// all-members: the rows are a hostname, its public CNAME target and its
// verification state; changing them needs organization:manage.
export const listTrackingDomains = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('trackingDomains').collect(); // bounded: tracking domains (few per org)
	},
});

// Remove a tracking domain
export const removeTrackingDomain = authedMutation({
	args: {
		trackingDomainId: v.id('trackingDomains'),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can perform this action'
		);

		await getOrThrow(ctx, args.trackingDomainId, 'Tracking domain');

		await ctx.db.delete(args.trackingDomainId);

		// Truthy sentinel so the caller can tell success from a caught failure
		// (the Operation module's run() resolves to `undefined` on error). Without
		// it the FE bails before closing the confirm dialog and toasting.
		return { success: true };
	},
});

/**
 * The tracking domain a campaign send from `from` rewrites its links to, or
 * `null` for the default tracking base URL. The rule is
 * `trackingDomainVerdict.ts:selectTrackingDomainForSender`.
 */
export const getTrackingDomainForSender = internalQuery({
	args: { from: v.string() },
	handler: async (ctx, args): Promise<string | null> => {
		const rows = await ctx.db.query('trackingDomains').take(TRACKING_DOMAIN_LIMIT);
		return selectTrackingDomainForSender(rows, args.from);
	},
});

// A deployment holds a handful; the bound keeps every whole-table read finite.
const TRACKING_DOMAIN_LIMIT = 100;

/** The row a check runs against, read in the check's first phase. */
export const getTrackingDomainForCheck = internalQuery({
	args: { trackingDomainId: v.id('trackingDomains') },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.trackingDomainId);
		return row ? { domain: row.domain, cnameTarget: row.cnameTarget } : null;
	},
});

/**
 * The check's one commit: land the outcome as `planTrackingDomainCheck` says,
 * audit a change of verified state, and schedule the confirming check a
 * verified domain's first failure needs. Writes nothing when the row was
 * removed or renamed while the check ran.
 */
export const recordTrackingDomainCheck = internalMutation({
	args: {
		trackingDomainId: v.id('trackingDomains'),
		domain: v.string(),
		outcome: trackingDomainCheckOutcomeValidator,
	},
	handler: async (ctx, args): Promise<null> => {
		const row = await ctx.db.get(args.trackingDomainId);
		if (!row || row.domain !== args.domain) return null;
		const plan = planTrackingDomainCheck(row, args.outcome, Date.now());
		await ctx.db.patch(args.trackingDomainId, plan.patch);
		if (plan.transition !== null) {
			await recordAuditLog(ctx, {
				userId: 'system:verifier',
				action:
					plan.transition === 'verified'
						? 'tracking_domain.verified'
						: 'tracking_domain.verification_failed',
				resource: 'tracking_domain',
				resourceId: args.trackingDomainId,
				details: { domain: row.domain, outcome: args.outcome },
			});
		}
		if (plan.confirmAfterMs !== null) {
			await ctx.scheduler.runAfter(
				plan.confirmAfterMs,
				internal.domains.trackingDomainCheck.checkTrackingDomain,
				{ trackingDomainId: args.trackingDomainId }
			);
		}
		return null;
	},
});

/**
 * Schedule a check of every tracking domain that was ever verified, spread by
 * `staggerMs`. Called by the daily sending-domain sweep
 * (`reverificationSweep.ts`). A domain never verified is left to its operator,
 * who is still setting it up and checks it with the Verify button.
 */
export async function scheduleTrackingDomainRechecks(
	ctx: MutationCtx,
	staggerMs: number
): Promise<number> {
	const rows = await ctx.db.query('trackingDomains').take(TRACKING_DOMAIN_LIMIT);
	let scheduled = 0;
	for (const row of rows) {
		if (row.verifiedAt === undefined) continue;
		await ctx.scheduler.runAfter(
			scheduled * staggerMs,
			internal.domains.trackingDomainCheck.checkTrackingDomain,
			{ trackingDomainId: row._id }
		);
		scheduled += 1;
	}
	return scheduled;
}

// The previous release's Verify scheduled this action and let a CNAME match
// verify the domain through `markVerifiedInternal`. Both stay for one release
// for jobs queued before the deploy, and both now run the full check instead.
export const verifyTrackingDomainDns = internalAction({
	args: {
		trackingDomainId: v.id('trackingDomains'),
		domain: v.string(),
		expectedCname: v.string(),
	},
	handler: async (ctx, args): Promise<null> => {
		await ctx.scheduler.runAfter(0, internal.domains.trackingDomainCheck.checkTrackingDomain, {
			trackingDomainId: args.trackingDomainId,
		});
		return null;
	},
});

export const markVerifiedInternal = internalMutation({
	args: { trackingDomainId: v.id('trackingDomains') },
	handler: async (ctx, args): Promise<null> => {
		if (!(await ctx.db.get(args.trackingDomainId))) return null;
		await ctx.scheduler.runAfter(0, internal.domains.trackingDomainCheck.checkTrackingDomain, {
			trackingDomainId: args.trackingDomainId,
		});
		return null;
	},
});

// The previous release's campaign send hop reads this by path; kept for one
// release for hops mid-run during the deploy. This release reads
// `getTrackingDomainForSender`.
export const getActiveTrackingDomain = internalQuery({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query('trackingDomains').take(TRACKING_DOMAIN_LIMIT);
		return rows.find((row) => row.isVerified) ?? null;
	},
});
