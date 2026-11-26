/**
 * The optional second DKIM key of an MTA sending domain (Ed25519, RFC 8463).
 *
 * An admin opts a domain in with `addKey` and out with `removeKey`. The MTA
 * keeps the key next to the domain's RSA key and adds an `ed25519-sha256`
 * signature below the RSA one once the record is in DNS; receivers that do not
 * know Ed25519 ignore it. The record is listed with `optional: true` and never
 * moves the domain's status (`lifecycleDkim.setOptionalDkimRecord`).
 *
 * The key belongs to this one signing domain: a stream subdomain that signs
 * with its own key has none until someone adds one for it. A key rotation does
 * not replace it; removing and adding it gives a new key and selector.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalQuery } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { createMtaIdentityManager } from '../lib/emailProviders/mtaIdentity';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { throwInternal, throwInvalidState, throwNotFound } from '../_utils/errors';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from './providers';
import { LIFECYCLE_USER_PUBLIC_MUTATION } from './lifecycle';

/**
 * The domain a key change acts on, after the same `organization:manage` gate
 * the other domain-changing functions use. Runs under the action's identity.
 */
export const loadForKeyChange = internalQuery({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage sending domains'
		);
		const domain = await ctx.db.get(args.domainId);
		if (!domain) return null;
		return {
			organizationId: session.activeOrganizationId,
			domain: domain.domain,
			providerType: domain.providerType,
			status: domain.status,
		};
	},
});

type KeyChangeTarget = {
	organizationId: string;
	domain: string;
	providerType?: string;
	status: string;
};

function assertChangeable(target: KeyChangeTarget | null): asserts target is KeyChangeTarget {
	if (!target) throwNotFound('Domain');
	if (target.providerType !== OWN_SENDING_DOMAIN_PROVIDER_KIND) {
		throwInvalidState('Only domains sent through the built-in MTA have an Ed25519 key.');
	}
	if (target.status === 'registering') {
		throwInvalidState('Domain is still being registered. Please wait a moment and try again.');
	}
}

/** The MTA call, with its failure surfaced to the admin rather than as a bare server error. */
async function callMta<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throwInternal(error instanceof Error ? error.message : 'The MTA did not answer');
	}
}

function assertCommitted(
	outcome: { ok: true; changed: boolean } | { ok: false; reason: string }
): void {
	if (outcome.ok) return;
	if (outcome.reason === 'domain_not_found') throwNotFound('Domain');
	throwInvalidState(`Cannot change the domain's DKIM keys: ${outcome.reason}`);
}

// authz: organization:manage is enforced by `loadForKeyChange` before the MTA call.
export const addKey = authedAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<{ selector: string; dnsRecord: string }> => {
		const target = await ctx.runQuery(internal.domains.dkimEd25519.loadForKeyChange, args);
		assertChangeable(target);
		const key = await callMta(() =>
			createMtaIdentityManager().createEd25519Key(target.domain, target.organizationId)
		);
		const outcome = await ctx.runMutation(internal.domains.lifecycleDkim.setOptionalDkimRecord, {
			domainId: args.domainId,
			record: key,
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		assertCommitted(outcome);
		return key;
	},
});

// authz: organization:manage is enforced by `loadForKeyChange` before the MTA call.
export const removeKey = authedAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<null> => {
		const target = await ctx.runQuery(internal.domains.dkimEd25519.loadForKeyChange, args);
		assertChangeable(target);
		await callMta(() =>
			createMtaIdentityManager().removeEd25519Key(target.domain, target.organizationId)
		);
		const outcome = await ctx.runMutation(internal.domains.lifecycleDkim.setOptionalDkimRecord, {
			domainId: args.domainId,
			record: null,
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		assertCommitted(outcome);
		return null;
	},
});
