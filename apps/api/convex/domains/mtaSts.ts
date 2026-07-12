/**
 * MTA-STS publishing (RFC 8461) — the deployment's OWN policy surface.
 *
 * Owlat's MTA already *enforces* other domains' MTA-STS when sending outbound
 * (`apps/mta/src/smtp/mtaSts.ts`); this is the reciprocal receiving side that
 * lets the operator PUBLISH their own policy so senders delivering TO this
 * deployment are told to require verified TLS.
 *
 * This module holds the two READ queries (V8 runtime): the public policy
 * content the Nuxt route serves and the admin DNS-record guidance. The LIVE
 * verification action lives in the sibling `domains/mtaStsVerify.ts` because it
 * needs `node:dns` + `fetch` and must therefore be a `'use node'` module (Convex
 * forbids queries/mutations in a Node runtime module) — the two files together
 * are the MTA-STS backend surface the reviewer asked to split out of
 * `domains/domains.ts` + `domains/dnsVerification.ts`.
 */

import {
	type MtaStsMode,
	type MtaStsPublishedMode,
	buildMtaStsPolicy,
	buildMtaStsTxtValue,
	mtaStsPolicyId,
} from '@owlat/shared/mtaStsPolicy';
import { authedQuery, publicQuery } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOptional } from '../lib/env';

// public: MTA-STS policy content for the public `/.well-known/mta-sts.txt`
// route. The MTA-STS policy file is served UNAUTHENTICATED over HTTPS to any
// sending MTA (RFC 8461 §3.2) — it carries only the deployment's own public MX
// hostname and posture, never a secret, so it is intentionally a `publicQuery`.
// Returns `null` when nothing should be published: no policy mode set (`none`
// or unset) or no inbound mail host (send-only install, `EHLO_HOSTNAME` unset),
// so the route answers 404. When published, the caller serves `body` verbatim
// and can surface `policyId` (the RFC 8461 TXT-record id) for DNS guidance.
export const getMtaStsPolicy = publicQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{ mode: MtaStsPublishedMode; policyId: string; body: string } | null> => {
		const settings = await ctx.db.query('instanceSettings').first();
		const mode: MtaStsMode = settings?.mtaStsMode ?? 'none';
		if (mode === 'none') return null;

		const mailHost = getOptional('EHLO_HOSTNAME')?.trim() || null;
		if (!mailHost) return null;

		const mx = [mailHost];
		return {
			mode,
			policyId: mtaStsPolicyId(mode, mx),
			body: buildMtaStsPolicy(mode, mx),
		};
	},
});

// Query: MTA-STS DNS guidance for the Settings → Domains "Receiving" panel.
// Admin-gated (`organization:manage`, mirroring `getInboundMailConfig`): the
// values become public DNS, but the read stays operator-only for parity with
// the rest of the domain-management surface. Returns the current publishing
// `mode`, the deployment mail host that becomes the MX, and — when a policy is
// being published — the `policyId` and the exact `_mta-sts` TXT record value the
// operator must publish. `policyId`/`txtValue` are null when nothing is
// published (`mode === 'none'` or no mail host), so the UI omits the records.
export const getMtaStsGuidance = authedQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{
		mode: MtaStsMode;
		mailHost: string | null;
		policyId: string | null;
		txtValue: string | null;
	}> => {
		await requireOrgPermission(ctx, 'organization:manage');
		const settings = await ctx.db.query('instanceSettings').first();
		const mode: MtaStsMode = settings?.mtaStsMode ?? 'none';
		const mailHost = getOptional('EHLO_HOSTNAME')?.trim() || null;

		if (mode === 'none' || !mailHost) {
			return { mode, mailHost, policyId: null, txtValue: null };
		}
		const policyId = mtaStsPolicyId(mode, [mailHost]);
		return { mode, mailHost, policyId, txtValue: buildMtaStsTxtValue(policyId) };
	},
});
