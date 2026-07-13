/**
 * Organization settings (module) — sole writer of the singleton
 * `instanceSettings` row's *settings columns* (`emailTheme`, `timezone`,
 * `defaultFromName`, `defaultFromEmail`, `isMigrationMode`, `updatedAt`). Sibling of
 * **Feature flags (module)** (which owns the `featureFlags` map),
 * **Abuse status (module)** (which owns the abuse-status columns), and
 * the **Organization deletion (module)** walker scheduled by `remove`.
 *
 * Four entry points:
 *   - `get`              — read the singleton row (auth-gated).
 *   - `update`           — patch the settings columns; requires
 *                         `settings:manage` (owner/admin). Unifies the
 *                         pre-deepening drift where any signed-in member
 *                         could write these fields.
 *   - `remove`           — schedules the **Organization deletion**
 *                         walker; owner-only.
 *   - `createInternal`   — idempotent bootstrap insert (called by
 *                         `seedAdmin.ts`).
 *
 * See docs/adr/0026-organization-settings-modules.md.
 */

import { v } from 'convex/values';
import { MAX_TRUSTED_ARC_FORWARDERS, sanitizeTrustedForwarders } from '@owlat/shared/arcTrust';
import { sealPolicyValidator } from '../mail/sealPolicy';
import { internalMutation } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import {
	getUserIdFromSession,
	getMutationContext,
	requirePermission,
	requireOrgPermission,
} from '../lib/sessionOrganization';

export const get = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);
		return await ctx.db.query('instanceSettings').first();
	},
});

export const update = authedMutation({
	args: {
		timezone: v.optional(v.string()),
		defaultFromName: v.optional(v.string()),
		defaultFromEmail: v.optional(v.string()),
		isMigrationMode: v.optional(v.boolean()),
		// When on, campaign sends may use any from-address on a verified sending
		// domain, not just the curated `campaignSenders` list. Defaults OFF.
		isCustomCampaignSendersAllowed: v.optional(v.boolean()),
		// MTA-STS publishing posture for inbound mail (RFC 8461). Defaults to
		// `none` (nothing published) — step through `testing` before `enforce`.
		mtaStsMode: v.optional(v.union(v.literal('none'), v.literal('testing'), v.literal('enforce'))),
		// Trusted ARC forwarders (Sealed Mail A5) — domains whose validated ARC seal
		// rescues an inbound DMARC fail. Unset keeps the seeded default list; an
		// explicit `[]` turns the override off.
		trustedArcForwarders: v.optional(v.array(v.string())),
		// Sealed Mail (E3) org sealing policy (locked decision D2): `auto` / `ask` /
		// `off`. Unset ⇒ `auto` at resolution time.
		sealPolicy: v.optional(sealPolicyValidator),
		emailTheme: v.optional(
			v.object({
				primaryColor: v.string(),
				fontFamily: v.string(),
				backgroundColor: v.string(),
				baseWidth: v.optional(v.number()),
			})
		),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'settings:manage',
			'Only owners and admins can update organization settings'
		);
		const now = Date.now();
		if (
			args.trustedArcForwarders !== undefined &&
			args.trustedArcForwarders.length > MAX_TRUSTED_ARC_FORWARDERS
		) {
			throw new Error(`At most ${MAX_TRUSTED_ARC_FORWARDERS} trusted ARC forwarders are allowed`);
		}
		// Validate the trusted-forwarder list server-side: normalize, drop
		// single-label / whitespace entries, and de-duplicate so the persisted
		// list can never contain an entry the ARC trust predicate would misread as
		// a TLD wildcard. The UI enforces the same rule; this is the floor.
		const patch =
			args.trustedArcForwarders !== undefined
				? { ...args, trustedArcForwarders: sanitizeTrustedForwarders(args.trustedArcForwarders) }
				: args;
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) {
			await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
			return existing._id;
		}
		return await ctx.db.insert('instanceSettings', {
			...patch,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const remove = authedMutation({
	args: {},
	handler: async (ctx) => {
		const session = await getMutationContext(ctx);
		requirePermission(session.role === 'owner', 'Only the owner can delete the organization');
		await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.start, {});
		return { success: true, message: 'Organization deletion started' };
	},
});

export const createInternal = internalMutation({
	args: {
		timezone: v.optional(v.string()),
		defaultFromName: v.optional(v.string()),
		// Seeded by the setup wizard's "moving from another platform?" question.
		isMigrationMode: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) return existing._id;
		const now = Date.now();
		return await ctx.db.insert('instanceSettings', {
			timezone: args.timezone || 'UTC',
			defaultFromName: args.defaultFromName,
			isMigrationMode: args.isMigrationMode ?? false,
			createdAt: now,
		});
	},
});
