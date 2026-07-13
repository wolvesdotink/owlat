/**
 * v8-isolate-resident helpers used by the Node-side dispatchDraft action.
 *
 * Convex requires `query` and `mutation` definitions to live in non-node
 * files (they only run in the v8 runtime), so the action in mailOutbound.ts
 * (`'use node'`) calls into these via `internal.mail.outboundQueries.*`.
 *
 * The claim/revert/writeSentMessage trio that used to live here moved to
 * the Mail draft lifecycle module — the sole writer of `mailDrafts.state`
 * and the multi-table send-success cascade. See ADR-0028. The only thing
 * left in this file is the threading-header lookup the dispatcher does
 * before building the RFC 5322 envelope.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { normalizeEmail } from '@owlat/shared';
import { sealPolicyValidator, type RecipientKeyState, type SealInputs } from './sealPolicy';

export const getMessage = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => ctx.db.get(args.messageId),
});

/**
 * Load the per-recipient TOFU trust state for a set of addresses, deduped on the
 * normalized address (a To+Cc collision is asked once and the all-recipients rule
 * counts each address exactly once). Shared by the dispatch-time seal decision
 * (`getOutboundSealInputs`) and the composer's `getSealState` so the two paths can
 * never drift into different "who has a key?" answers. Returns PUBLIC material
 * only: the pinned public key rides along only for a `trusted` row; an address
 * with no discovery row at all is `missing`.
 */
export async function loadRecipientKeyStates(
	ctx: QueryCtx,
	addresses: string[]
): Promise<RecipientKeyState[]> {
	const seen = new Set<string>();
	const recipients: RecipientKeyState[] = [];
	for (const raw of addresses) {
		const address = normalizeEmail(raw);
		if (seen.has(address)) continue;
		seen.add(address);
		const row = await ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (!row) {
			recipients.push({ address, outcome: 'missing' });
			continue;
		}
		// A pinned public key is only usable to seal when the row is `trusted`.
		recipients.push({
			address,
			outcome: row.outcome,
			...(row.outcome === 'trusted' && row.pinnedPublicKeyArmored
				? { pinnedPublicKeyArmored: row.pinnedPublicKeyArmored }
				: {}),
		});
	}
	return recipients;
}

/**
 * Return normalized recipients whose discovery cache is absent or expired.
 * Dispatch uses this bounded list to refresh keys before making the final seal
 * decision; the composer remains a read-only view of the current cache.
 */
export async function loadDiscoveryAddresses(
	ctx: QueryCtx,
	addresses: string[]
): Promise<string[]> {
	const seen = new Set<string>();
	const stale: string[] = [];
	const now = Date.now();
	for (const raw of addresses) {
		const address = normalizeEmail(raw);
		if (seen.has(address)) continue;
		seen.add(address);
		const row = await ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (!row || row.expiresAt <= now) stale.push(address);
	}
	return stale;
}

/**
 * Whether the sender address has an ACTIVE signing key in the vault. The seal
 * decision needs a live signing key for the From address (its private half is
 * opened by the Node action, never here). Shared by the dispatch path
 * (`getOutboundSealInputs`) and the composer's seal-state query so both derive
 * the same "can this address sign?" answer. Returns a boolean only — no key
 * material of any kind crosses this boundary.
 */
export async function hasActiveSigningKey(ctx: QueryCtx, fromAddress: string): Promise<boolean> {
	const signingAddress = normalizeEmail(fromAddress);
	const signingRow = await ctx.db
		.query('keyVault')
		.withIndex('by_address', (q) => q.eq('address', signingAddress))
		.first();
	return !!signingRow && signingRow.isActive;
}

/**
 * Gather everything the dispatch-time seal decision (`mail/sealPolicy.decideSeal`)
 * reads, from the V8 plane, so the Node `dispatchDraft` action can decide whether
 * to seal without a direct db handle. Returns PUBLIC material only: recipient
 * PUBLIC keys (safe to expose — that is the whole point of key discovery) and a
 * boolean `hasSigningKey` (never the sender's private key, which the action opens
 * itself from the internal vault query). The `sealedMail` flag, the org policy
 * (`auto` when unset), and per-recipient TOFU state come along so the pure
 * decision stays a single source of truth across the composer and the sender.
 */
export const getOutboundSealInputs = internalQuery({
	args: { fromAddress: v.string(), recipients: v.array(v.string()) },
	returns: v.object({
		flagEnabled: v.boolean(),
		policy: sealPolicyValidator,
		hasSigningKey: v.boolean(),
		discoveryAddresses: v.array(v.string()),
		recipients: v.array(
			v.object({
				address: v.string(),
				outcome: v.union(
					v.literal('trusted'),
					v.literal('keyChanged'),
					v.literal('notFound'),
					v.literal('missing')
				),
				pinnedPublicKeyArmored: v.optional(v.string()),
			})
		),
	}),
	handler: async (ctx, args): Promise<SealInputs & { discoveryAddresses: string[] }> => {
		const flagEnabled = await isFeatureEnabled(ctx, 'sealedMail');
		const settings = await ctx.db.query('instanceSettings').first();
		const policy = settings?.sealPolicy ?? 'auto';
		// Sealed Mail off: skip the per-recipient discovery reads entirely — the
		// decision is `flag_off` regardless, so the send path stays byte-identical
		// to today for every deployment that has not enabled the flag.
		if (!flagEnabled) {
			return {
				flagEnabled: false,
				policy,
				hasSigningKey: false,
				discoveryAddresses: [],
				recipients: [],
			};
		}

		const hasSigningKey = await hasActiveSigningKey(ctx, args.fromAddress);
		const recipients = await loadRecipientKeyStates(ctx, args.recipients);
		const discoveryAddresses = await loadDiscoveryAddresses(ctx, args.recipients);
		return { flagEnabled, policy, hasSigningKey, discoveryAddresses, recipients };
	},
});
