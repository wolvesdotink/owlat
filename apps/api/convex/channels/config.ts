/**
 * Channel configuration: the settings and dashboard read, the admin save, and
 * the internal reads and the credential write the `'use node'` actions in
 * `outbound.ts` and `credentials.ts` call.
 *
 * Each builder's body is an exported helper, so the previous release's paths
 * (`unifiedMessages.ts` at the convex root) run the same code.
 */

import { v, type ObjectType } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import {
	hasPermission,
	requirePermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { unifiedMessageChannelValidator } from '../lib/convexValidators';

/**
 * Get channel configuration and health status.
 *
 * `configuredFields` is what makes a partial credential re-save safe to offer:
 * the encrypted envelope can never be read back into the settings form (it is
 * openable only in a `'use node'` action), so the form uses the field NAMES to
 * mark the inputs it must not ask for again and leaves them blank, and
 * `channels.outbound.encryptAndPersistConfig` merges the save over what is
 * stored. Admin-only, like every other credential-shaped field.
 */
export async function channelConfigsForCaller(ctx: QueryCtx, session: MutationSessionContext) {
	// all-members: health/display fields feed the dashboard channel card.
	// The encrypted credential envelope NEVER leaves the backend — no client
	// surface can open it, so none of them is given it. The presence map of
	// what is inside it (configuredFields) is admin-only: members get the row
	// without it, the settings page (admin) gets it for the edit form.
	const rows = await ctx.db.query('channelConfigs').collect(); // bounded: ≤5 channel-config rows (schema literal union)
	// The floor already resolved this caller's role — the dashboard live-
	// subscribes here, so re-reading the session would double every tick.
	const isAdmin = hasPermission(session.role, 'organization:manage');
	return rows.map((row) => ({
		...row,
		config: undefined,
		...(isAdmin ? {} : { configuredFields: undefined }),
	}));
}

// all-members: health/display fields feed the dashboard channel card;
// channelConfigsForCaller never returns the credential envelope and gives the
// configuredFields presence map to admins only.
export const getChannelConfigs = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => await channelConfigsForCaller(ctx, session),
});

/**
 * Update channel configuration.
 *
 * The non-secret fields (`isEnabled`, `displayName`) are written inline.
 * The credential `config` blob is NEVER written here in plaintext — this is a
 * v8 mutation and `encryptSecret` is Node-only. When a `config` is supplied we
 * schedule the Node action `channels.outbound.encryptAndPersistConfig`, which
 * wraps it in an AES-256-GCM envelope and patches the row. The
 * `channelConfigs.config` column therefore only ever holds an encrypted
 * envelope on disk (encrypt-on-write, A3). Atomic single-org policy: no dual
 * plaintext read path — `channels.outbound.dispatchOutbound` always decrypts.
 */
export const updateChannelConfigArgs = {
	channel: unifiedMessageChannelValidator,
	isEnabled: v.optional(v.boolean()),
	displayName: v.optional(v.string()),
	config: v.optional(v.string()),
};

export async function saveChannelConfig(
	ctx: MutationCtx,
	args: ObjectType<typeof updateChannelConfigArgs>,
	session: MutationSessionContext
) {
	requirePermission(
		hasPermission(session.role, 'organization:manage'),
		'Only owners and admins can configure channels'
	);
	const existing = await ctx.db
		.query('channelConfigs')
		.withIndex('by_channel', (q) => q.eq('channel', args.channel))
		.first();

	const now = Date.now();
	let configId: Id<'channelConfigs'>;
	if (existing) {
		await ctx.db.patch(existing._id, {
			...(args.isEnabled !== undefined ? { isEnabled: args.isEnabled } : {}),
			...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
			updatedAt: now,
		});
		configId = existing._id;
	} else {
		configId = await ctx.db.insert('channelConfigs', {
			channel: args.channel,
			isEnabled: args.isEnabled ?? false,
			displayName: args.displayName,
			// config left unset until the encrypt action persists the envelope.
			createdAt: now,
			updatedAt: now,
		});
	}

	// Encrypt-on-write: hand the plaintext to the Node action, which encrypts
	// and patches `config`. The plaintext never lands in the row.
	if (args.config !== undefined) {
		await ctx.scheduler.runAfter(0, internal.channels.outbound.encryptAndPersistConfig, {
			channel: args.channel,
			plaintextConfig: args.config,
		});
	}

	return configId;
}

// authz: saveChannelConfig requires organization:manage before it writes.
export const updateChannelConfig = authedMutation({
	args: updateChannelConfigArgs,
	handler: async (ctx, args, session) => await saveChannelConfig(ctx, args, session),
});

/**
 * Patch the encrypted credential envelope onto a channel config row. Sole
 * writer of the `config` and `configuredFields` columns. Called only by
 * `channels.outbound.encryptAndPersistConfig` after it merged the save over the
 * stored credentials and encrypted the result — `config` is always a serialized
 * AES-256-GCM envelope, never plaintext, and `configuredFields` names the fields
 * inside it (names only) so the v8 settings query can report which credentials
 * are stored without being able to open the envelope.
 */
export const setChannelConfigSecretArgs = {
	channel: unifiedMessageChannelValidator,
	config: v.string(),
	configuredFields: v.array(v.string()),
};

export async function writeChannelConfigSecret(
	ctx: MutationCtx,
	args: ObjectType<typeof setChannelConfigSecretArgs>
) {
	const existing = await ctx.db
		.query('channelConfigs')
		.withIndex('by_channel', (q) => q.eq('channel', args.channel))
		.first();
	// updateChannelConfig creates the row in the same mutation before
	// scheduling the encrypt action, so a missing row here means it was
	// deleted in the interim — surface that loudly rather than silently
	// dropping the credential (which would leave the channel un-sendable
	// with no signal).
	if (!existing) {
		throw new Error(
			`setChannelConfigSecret: no channelConfigs row for channel '${args.channel}' — encrypted credential was not persisted`
		);
	}
	await ctx.db.patch(existing._id, {
		config: args.config,
		configuredFields: args.configuredFields,
		updatedAt: Date.now(),
	});
}

export const setChannelConfigSecret = internalMutation({
	args: setChannelConfigSecretArgs,
	handler: async (ctx, args) => await writeChannelConfigSecret(ctx, args),
});

/**
 * Internal read of a single channel config (including the encrypted `config`
 * envelope) for the Node dispatch action. Not exposed publicly — decryption
 * happens in `channels.outbound.dispatchOutbound`.
 */
export const getChannelConfigInternalArgs = {
	channel: unifiedMessageChannelValidator,
};

export async function channelConfigByChannel(
	ctx: QueryCtx,
	args: ObjectType<typeof getChannelConfigInternalArgs>
) {
	return await ctx.db
		.query('channelConfigs')
		.withIndex('by_channel', (q) => q.eq('channel', args.channel))
		.first();
}

export const getChannelConfigInternal = internalQuery({
	args: getChannelConfigInternalArgs,
	handler: async (ctx, args) => await channelConfigByChannel(ctx, args),
});
