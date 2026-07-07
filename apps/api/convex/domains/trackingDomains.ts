/**
 * Custom Tracking Domains
 *
 * Allows organizations to use their own branded domains for click/open tracking.
 * Prevents reputation cross-contamination between tenants.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireAdminContext } from '../lib/sessionOrganization';
import { throwNotFound, throwAlreadyExists } from '../_utils/errors';
import { getOptional } from '../lib/env';

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
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);

		// Ensure domain is not already registered
		const existing = await ctx.db
			.query('trackingDomains')
			.withIndex('by_domain', (q) => q.eq('domain', args.domain.toLowerCase()))
			.first();

		if (existing) {
			throwAlreadyExists('This domain is already registered');
		}

		// CNAME target = this deployment's own tracking host (CONVEX_SITE_URL),
		// where the /t/o and /t/c handlers are actually served — never a SaaS host.
		const cnameTarget = resolveCnameTarget();

		return await ctx.db.insert('trackingDomains', {
			domain: args.domain.toLowerCase(),
			cnameTarget,
			isVerified: false,
			verifiedAt: undefined,
			createdAt: Date.now(),
		});
	},
});

// Verify a tracking domain — schedules DNS verification action
export const verifyTrackingDomain = authedMutation({
	args: {
		trackingDomainId: v.id('trackingDomains'),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);

		const td = await ctx.db.get(args.trackingDomainId);
		if (!td) throwNotFound('Tracking domain');

		// Schedule DNS verification action
		await ctx.scheduler.runAfter(0, internal.domains.trackingDomains.verifyTrackingDomainDns, {
			trackingDomainId: args.trackingDomainId,
			domain: td.domain,
			expectedCname: td.cnameTarget,
		});

		// Return a truthy sentinel (mirrors `dnsVerification.verifyDomain`) so the
		// caller's Operation module can distinguish success from a caught failure
		// (run() resolves to `undefined` on error). Without this the FE success UX
		// — auto-expanding the row and toasting — never fires.
		return { success: true };
	},
});

// (Removed the redundant public markTrackingDomainVerified adminMutation — it
// had no caller and its comment was wrong; the DNS-verify action drives
// verification through the internal markVerifiedInternal mutation.)

// List tracking domains for org
export const listTrackingDomains = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('trackingDomains')
			.collect(); // bounded: tracking domains (few per org)
	},
});

// Remove a tracking domain
export const removeTrackingDomain = authedMutation({
	args: {
		trackingDomainId: v.id('trackingDomains'),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);

		const td = await ctx.db.get(args.trackingDomainId);
		if (!td) throwNotFound('Tracking domain');

		await ctx.db.delete(args.trackingDomainId);

		// Truthy sentinel so the caller can tell success from a caught failure
		// (the Operation module's run() resolves to `undefined` on error). Without
		// it the FE bails before closing the confirm dialog and toasting.
		return { success: true };
	},
});

// Get the active tracking domain for an org (verified only) — internal query for sending pipeline
export const getActiveTrackingDomain = internalQuery({
	args: {},
	handler: async (ctx) => {
		const domains = await ctx.db
			.query('trackingDomains')
			.collect(); // bounded: tracking domains (few per org)

		// Return first verified domain, or null
		return domains.find((d) => d.isVerified) ?? null;
	},
});

// Internal mutation to mark domain verified (called by DNS verification action)
export const markVerifiedInternal = internalMutation({
	args: {
		trackingDomainId: v.id('trackingDomains'),
	},
	handler: async (ctx, args) => {
		const td = await ctx.db.get(args.trackingDomainId);
		if (!td) return;

		await ctx.db.patch(args.trackingDomainId, {
			isVerified: true,
			verifiedAt: Date.now(),
		});
	},
});

/**
 * DNS verification action for tracking domains.
 * Uses fetch to resolve CNAME and verify it points to the expected target.
 * Note: Uses DNS-over-HTTPS (Cloudflare) since Convex actions can't use Node dns module directly.
 */
export const verifyTrackingDomainDns = internalAction({
	args: {
		trackingDomainId: v.id('trackingDomains'),
		domain: v.string(),
		expectedCname: v.string(),
	},
	handler: async (ctx, args) => {
		try {
			// Use Cloudflare DNS-over-HTTPS to resolve CNAME
			const dnsUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(args.domain)}&type=CNAME`;
			const response = await fetch(dnsUrl, {
				headers: { Accept: 'application/dns-json' },
			});

			if (!response.ok) {
				// eslint-disable-next-line no-console
				console.warn(`[Tracking Domain DNS] DNS query failed for ${args.domain}: ${response.status}`);
				return { verified: false, error: 'DNS query failed' };
			}

			const data = (await response.json()) as {
				Answer?: Array<{ type: number; data: string }>;
			};

			// Check if any CNAME answer matches the expected target
			const cnameAnswers = data.Answer?.filter((a) => a.type === 5) ?? [];
			const verified = cnameAnswers.some((a) => {
				// DNS responses may have trailing dot
				const resolved = a.data.replace(/\.$/, '').toLowerCase();
				return resolved === args.expectedCname.toLowerCase();
			});

			if (verified) {
				await ctx.runMutation(internal.domains.trackingDomains.markVerifiedInternal, {
					trackingDomainId: args.trackingDomainId,
				});
				return { verified: true };
			}

			// eslint-disable-next-line no-console
			console.warn(
				`[Tracking Domain DNS] CNAME for ${args.domain} does not match ${args.expectedCname}. Found: ${cnameAnswers.map((a) => a.data).join(', ') || 'no CNAME records'}`
			);
			return { verified: false, error: 'CNAME does not match expected target' };
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error(`[Tracking Domain DNS] Error verifying ${args.domain}:`, error);
			return { verified: false, error: 'DNS verification error' };
		}
	},
});
