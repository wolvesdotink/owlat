/**
 * Organization settings (module) — sole writer of the singleton
 * `instanceSettings` row's *settings columns* (`emailTheme`, `timezone`,
 * `defaultFromName`, `defaultFromEmail`, `isMigrationMode`,
 * `isInboundTlsRequired`, `updatedAt`). Sibling of
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
import { internalMutation, internalQuery } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { recordAuditLog } from '../lib/auditLog';
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
		// THE RAMP CONTROLLER'S GLOBAL KILL SWITCH (plan P3-2). True pins every ramp
		// cell at its current share: the hourly controller still evaluates and
		// audits, but writes no share. It is the plan's named mitigation for
		// controller complexity, so an owner/admin must be able to pull it from the
		// product — not only from an internal mutation.
		isRampControllerPaused: v.optional(v.boolean()),
		// What the relay charges, in minor units per thousand messages, with its
		// ISO-4217 code — the only input behind the Independence screen's
		// month-to-date "spend avoided". Optional in every sense: unset simply
		// means the figure is not shown.
		relayMinorUnitsPerThousand: v.optional(v.number()),
		relayCurrency: v.optional(v.string()),
		// Require STARTTLS before accepting MAIL FROM. Defaults ON; owners/admins
		// can disable it for legacy senders that cannot negotiate TLS.
		isInboundTlsRequired: v.optional(v.boolean()),
		// Deep body search (idea 32, ADR-0059) — index a ~8KB body excerpt instead
		// of only the 200-char snippet. Defaults OFF because it widens the
		// sealed-at-rest plaintext carve-out; turning it back off schedules the
		// sweep that clears the excerpts already written (see below).
		isBodySearchIndexingEnabled: v.optional(v.boolean()),
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
		const session = await requireOrgPermission(
			ctx,
			'settings:manage',
			'Only owners and admins can update organization settings'
		);
		const now = Date.now();
		if (
			args.relayMinorUnitsPerThousand !== undefined &&
			(!Number.isFinite(args.relayMinorUnitsPerThousand) || args.relayMinorUnitsPerThousand < 0)
		) {
			throw new Error('A relay price must be a non-negative number of minor units per thousand');
		}
		if (args.relayCurrency !== undefined && !/^[A-Za-z]{3}$/.test(args.relayCurrency)) {
			throw new Error('A relay currency must be a three-letter ISO-4217 code');
		}
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
		const patch = {
			...args,
			...(args.trustedArcForwarders !== undefined
				? { trustedArcForwarders: sanitizeTrustedForwarders(args.trustedArcForwarders) }
				: {}),
			// Stored upper-case so two spellings of one currency cannot format
			// differently on two screens.
			...(args.relayCurrency !== undefined
				? { relayCurrency: args.relayCurrency.toUpperCase() }
				: {}),
		};
		const existing = await ctx.db.query('instanceSettings').first();
		const changes: Record<string, { from: unknown; to: unknown }> = {};
		for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
			const to = patch[key];
			if (to === undefined) continue;
			const from = existing?.[key] ?? null;
			if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
		}

		let settingsId: Id<'instanceSettings'>;
		if (existing) {
			await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
			settingsId = existing._id;
		} else {
			settingsId = await ctx.db.insert('instanceSettings', {
				...patch,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (Object.keys(changes).length > 0) {
			await recordAuditLog(ctx, {
				userId: session.userId,
				action: 'settings.updated',
				resource: 'settings',
				resourceId: settingsId,
				detailsBlob: JSON.stringify({ changes }),
			});
		}
		if (args.isInboundTlsRequired !== undefined) {
			await ctx.scheduler.runAfter(0, internal.mail.mailboxActions.pushInboundTlsPolicy, {});
		}
		// THE OPT-OUT HAS TO REMOVE, NOT JUST STOP (ADR-0059). Deep body search
		// widens the plaintext carve-out to a ~8KB excerpt per message; an operator
		// who turns it off is asking for that plaintext to be gone, not merely for
		// new mail to skip it. A true→false transition therefore schedules the
		// sweep that clears every `searchBody` already written. Gated on the
		// TRANSITION (not on the argument) so re-saving an unrelated setting
		// while it is already off cannot restart the walk.
		if (args.isBodySearchIndexingEnabled === false && existing?.isBodySearchIndexingEnabled) {
			await ctx.scheduler.runAfter(0, internal.mail.bodySearchBackfill.purgeSearchBodies, {
				cursor: null,
			});
		}
		return settingsId;
	},
});

/** Read-side policy for the Node action that synchronizes the MTA Redis gate. */
export const getInboundTlsPolicy = internalQuery({
	args: {},
	handler: async (ctx): Promise<boolean> => {
		const settings = await ctx.db.query('instanceSettings').first();
		return settings?.isInboundTlsRequired !== false;
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
		// When true, stamp the durable admin-seed latch on the freshly-created
		// singleton so `POST /seed/admin` can never re-run against a de-populated
		// instance (see `adminSeedCompletedAt` in schema/instance.ts). Only the
		// seed path passes this; the bare setup-wizard bootstrap leaves it unset.
		markAdminSeeded: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) {
			// The singleton already exists (idempotent bootstrap). Still stamp the
			// latch if this is the seed path and it isn't stamped yet, so the gate
			// is durable even when settings were created before the user rows.
			if (args.markAdminSeeded && existing.adminSeedCompletedAt === undefined) {
				await ctx.db.patch(existing._id, { adminSeedCompletedAt: now });
			}
			return existing._id;
		}
		return await ctx.db.insert('instanceSettings', {
			timezone: args.timezone || 'UTC',
			defaultFromName: args.defaultFromName,
			isMigrationMode: args.isMigrationMode ?? false,
			...(args.markAdminSeeded ? { adminSeedCompletedAt: now } : {}),
			createdAt: now,
		});
	},
});

/**
 * Atomically CLAIM the durable admin-seed latch.
 *
 * In a SINGLE transaction this reads `adminSeedCompletedAt` and, only if it is
 * unset, stamps it — creating the `instanceSettings` singleton (with the seed's
 * settings columns) when none exists yet. Returns `{ claimed }`.
 *
 * `seedAdmin.ts` calls this BEFORE creating any user. Because the check and the
 * write happen in one Convex transaction (OCC-serialized on the singleton), two
 * concurrent `/seed/admin` requests can no longer both pass a separate
 * check-then-write and both seed: exactly one wins the claim, the loser reads the
 * now-stamped latch and gets a 409. A seed that fails AFTER a successful claim
 * leaves the latch set — fail-closed: no second unauthenticated bootstrap can
 * mint a fresh owner on the instance. Recovering from a half-seed therefore needs
 * operator action, which is the intended posture for a one-shot endpoint.
 */
export const claimAdminSeedInternal = internalMutation({
	args: {
		timezone: v.optional(v.string()),
		defaultFromName: v.optional(v.string()),
		isMigrationMode: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<{ claimed: boolean }> => {
		const now = Date.now();
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) {
			// Already latched ⇒ a prior seed claimed it; refuse (concurrent loser or
			// a re-run against a de-populated instance).
			if (existing.adminSeedCompletedAt !== undefined) {
				return { claimed: false };
			}
			await ctx.db.patch(existing._id, { adminSeedCompletedAt: now });
			return { claimed: true };
		}
		await ctx.db.insert('instanceSettings', {
			timezone: args.timezone || 'UTC',
			defaultFromName: args.defaultFromName,
			isMigrationMode: args.isMigrationMode ?? false,
			adminSeedCompletedAt: now,
			createdAt: now,
		});
		return { claimed: true };
	},
});

/**
 * Whether the durable admin-seed latch has been stamped. Read by
 * `seedAdmin.ts`'s one-shot gate alongside the "any user exists?" probe: the
 * probe re-arms if every user is deleted, this latch does not.
 */
export const hasCompletedAdminSeedInternal = internalQuery({
	args: {},
	handler: async (ctx): Promise<boolean> => {
		const settings = await ctx.db.query('instanceSettings').first();
		return settings?.adminSeedCompletedAt !== undefined;
	},
});
