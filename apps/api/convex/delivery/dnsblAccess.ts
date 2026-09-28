/**
 * Blocklist access: which resolver the MTA's blocklist lookups go through, and
 * the operator's optional Spamhaus Data Query Service key.
 *
 * Spamhaus refuses its public mirror to shared resolvers and to hosting ranges
 * with generic reverse DNS, and an unmeasured Spamhaus result holds a sending IP
 * back. A free DQS key is the fix that works from any host, so the Blocklist
 * lookups card lets an admin paste one.
 *
 * The key is RELAYED, never stored: this module hands it to the MTA, which
 * verifies it against Spamhaus's test entry and seals it at rest. Nothing
 * returned from here carries more than its last four characters.
 */

import { v } from 'convex/values';
import {
	normalizeDnsblAccess,
	type DnsblAccessKeyRejection,
	type MtaDnsblAccess,
} from '@owlat/mta-protocol/dnsblAccess';
import { isRecord } from '@owlat/shared/utils/guards';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getMtaConfig } from '../mail/mtaClient';

const MTA_TIMEOUT_MS = 5_000;
/** The key check makes one bounded Spamhaus query with retries on the MTA side. */
const MTA_KEY_CHECK_TIMEOUT_MS = 20_000;

export type DnsblAccessView =
	| { status: 'ready'; access: MtaDnsblAccess }
	/** No MTA configured, unreachable, or one that predates this endpoint. */
	| { status: 'unavailable' };

export type SpamhausKeyResult =
	| { ok: true; access: MtaDnsblAccess }
	| { ok: false; reason: DnsblAccessKeyRejection | 'mta_unavailable' };

const REJECTIONS: readonly DnsblAccessKeyRejection[] = [
	'invalid_key',
	'key_rejected',
	'resolver_refused',
	'rate_limited',
	'resolver_unreachable',
	'unusable_answer',
];

function isRejection(value: unknown): value is DnsblAccessKeyRejection {
	return REJECTIONS.some((reason) => reason === value);
}

async function callMta(method: 'GET' | 'PUT', body?: unknown): Promise<Response | null> {
	const mta = getMtaConfig();
	if (!mta) return null;
	try {
		return await fetch(`${mta.baseUrl}/dnsbl-access`, {
			method,
			headers: {
				Authorization: `Bearer ${mta.apiKey}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(method === 'PUT' ? MTA_KEY_CHECK_TIMEOUT_MS : MTA_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
}

// authz: admin floor (organization:manage) via internal.auth.membership
// .assertOrgAdmin — resolver and key state is instance delivery configuration.
export const get = authedAction({
	args: {},
	handler: async (ctx): Promise<DnsblAccessView> => {
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});
		const response = await callMta('GET');
		if (!response?.ok) return { status: 'unavailable' };
		const access = normalizeDnsblAccess(await response.json().catch(() => null));
		return access ? { status: 'ready', access } : { status: 'unavailable' };
	},
});

// authz: admin floor (organization:manage) via internal.auth.membership
// .assertOrgAdmin, and settings:manage again in recordKeyChange for the audit
// row — the key decides whether any sending IP can leave quarantine.
export const setSpamhausKey = authedAction({
	args: { key: v.union(v.string(), v.null()) },
	handler: async (ctx, args): Promise<SpamhausKeyResult> => {
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});
		const key = args.key === null ? null : args.key.trim();
		if (key !== null && !/^[a-zA-Z0-9]{16,64}$/.test(key)) {
			return { ok: false, reason: 'invalid_key' };
		}
		const response = await callMta('PUT', { spamhausDqsKey: key });
		if (!response) return { ok: false, reason: 'mta_unavailable' };
		const body: unknown = await response.json().catch(() => null);
		if (!isRecord(body)) return { ok: false, reason: 'mta_unavailable' };
		if (body['ok'] !== true) {
			return {
				ok: false,
				reason: isRejection(body['reason']) ? body['reason'] : 'mta_unavailable',
			};
		}
		const access = normalizeDnsblAccess(body['access']);
		if (!access) return { ok: false, reason: 'mta_unavailable' };
		await ctx.runMutation(internal.delivery.dnsblAccess.recordKeyChange, {
			change: key === null ? 'removed' : 'set',
		});
		return { ok: true, access };
	},
});

/** Audit row for a key change. Records THAT it changed, never the key. */
export const recordKeyChange = internalMutation({
	args: { change: v.union(v.literal('set'), v.literal('removed')) },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'settings:manage');
		const settings = await ctx.db.query('instanceSettings').first();
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'settings.updated',
			resource: 'settings',
			...(settings ? { resourceId: settings._id } : {}),
			detailsBlob: JSON.stringify({ changes: { spamhausDqsKey: args.change } }),
		});
	},
});
