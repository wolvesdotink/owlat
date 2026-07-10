/**
 * Campaign senders (module) — the curated list of from-addresses a campaign
 * may send from, plus the send-time enforcement helper.
 *
 * Locked product decision (2026-07-10 experience plan, decision 8): campaign
 * senders are CURATED. `instanceSettings.isCustomCampaignSendersAllowed` defaults
 * OFF for everyone (admins included); with it off, only an ENABLED row here may
 * be a campaign from-address. With it on, any from-address on a verified sending
 * domain is allowed. In BOTH branches the verified-domain hard gate remains the
 * floor — the write path rejects unverified domains at insert/update time, and
 * `campaigns/preflight.ts` + `campaigns/testSend.ts` keep the domain check.
 *
 * Single-org-per-deployment: the table has no `organizationId` column, mirroring
 * `campaigns` and the `instanceSettings` singleton. `email` is stored lowercased.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { checkEmailDomainVerification } from '../domains/domains';
import { isValidEmail } from '../lib/inputGuards';
import { throwInvalidInput, throwNotFound, throwAlreadyExists } from '../_utils/errors';

type Ctx = QueryCtx | MutationCtx;

/**
 * `createdBy` sentinel for the bootstrap seed row (`seedDefaultSenderIfNeeded`),
 * which runs on the send path as any member rather than as a specific admin.
 */
const SYSTEM_SEED_CREATED_BY = 'system';

/**
 * Gate every campaign-sender management surface (the `list` query and the CRUD
 * mutations) on ONE permission, so brief decision 8's d4 remap of
 * `campaigns:manage` to editors moves all of them together. Extracted so the
 * identical call can't drift across the five call sites.
 */
async function requireCampaignSendersManage(ctx: QueryCtx | MutationCtx) {
	return await requireOrgPermission(
		ctx,
		'campaigns:manage',
		'Only owners and admins can manage campaign senders'
	);
}

/**
 * The single user-facing sentence shown when a from-address is neither an
 * enabled curated sender nor covered by the custom-senders toggle. Exported so
 * the campaign preflight and both test-send actions surface identical copy.
 */
export function senderNotAllowedMessage(fromEmail: string): string {
	return (
		`"${fromEmail}" is not an approved campaign sender. ` +
		'Add it under Campaign senders, or allow custom senders in Settings.'
	);
}

/**
 * Normalize a from-address for storage / lookup: trimmed + lowercased. Callers
 * that display the value keep the raw form in `displayName`, not here.
 */
function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Look up a curated sender row by (normalized) email. Case-insensitive.
 */
async function findByEmail(ctx: Ctx, email: string): Promise<Doc<'campaignSenders'> | null> {
	return await ctx.db
		.query('campaignSenders')
		.withIndex('by_email', (q) => q.eq('email', normalizeEmail(email)))
		.first();
}

/**
 * Whether the given from-address is a permitted campaign sender, independent of
 * the verified-domain floor (which callers already enforce separately).
 *
 * Allowed when the address is an ENABLED curated sender, OR when
 * `isCustomCampaignSendersAllowed` is on. This is the ONLY list/toggle gate — the
 * domain-verification hard gate lives in the send-time callers so its dedicated
 * "domain not verified" message keeps surfacing.
 */
export async function isCampaignSenderAllowed(ctx: Ctx, fromEmail: string): Promise<boolean> {
	const sender = await findByEmail(ctx, fromEmail);
	if (sender && sender.isEnabled) {
		return true;
	}
	const settings = await ctx.db.query('instanceSettings').first();
	return settings?.isCustomCampaignSendersAllowed === true;
}

/**
 * InternalQuery wrapper so actions (`campaigns/testSend.ts`) can run the
 * list/toggle gate without a direct db handle.
 */
export const checkSenderAllowed = internalQuery({
	args: { fromEmail: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		return await isCampaignSenderAllowed(ctx, args.fromEmail);
	},
});

/**
 * Validate that a would-be curated sender sits on a verified sending domain.
 * Shared by `create` and `update`. Throws `invalid_input` when the address is
 * malformed or its domain is not verified. Never let an unverified domain onto
 * the curated list — that would create a hole in the send-time floor.
 */
async function assertVerifiedSenderDomain(ctx: MutationCtx, email: string): Promise<void> {
	if (!isValidEmail(email)) {
		throwInvalidInput(`Invalid email address: ${email}`);
	}
	const status = await checkEmailDomainVerification(ctx, email);
	if (!status.verified) {
		throwInvalidInput(
			status.error ??
				`Domain "${status.domain}" is not verified. Verify it in Settings > Domains before adding it as a campaign sender.`
		);
	}
}

/**
 * List every curated campaign sender. Gated on `campaigns:manage` (not merely a
 * role) so it moves with the four mutations when d4 remaps that permission to
 * editors — otherwise one surface would split across two auth models.
 */
export const list = authedQuery({
	args: {},
	handler: async (ctx): Promise<Doc<'campaignSenders'>[]> => {
		await requireCampaignSendersManage(ctx);
		// bounded: curated list is intentionally tiny (a handful of addresses).
		return await ctx.db.query('campaignSenders').take(200);
	},
});

/**
 * Add a curated sender. Rejects unverified-domain addresses and duplicates. The
 * first sender added (or one explicitly flagged) becomes the default.
 */
export const create = authedMutation({
	args: {
		email: v.string(),
		displayName: v.optional(v.string()),
		isEnabled: v.optional(v.boolean()),
		isDefault: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const session = await requireCampaignSendersManage(ctx);
		const email = normalizeEmail(args.email);
		await assertVerifiedSenderDomain(ctx, email);

		const existing = await findByEmail(ctx, email);
		if (existing) {
			throwAlreadyExists(`"${email}" is already a campaign sender.`);
		}

		const now = Date.now();
		// First-ever sender is the default; otherwise honor the explicit flag.
		const anySender = await ctx.db.query('campaignSenders').first();
		const makeDefault = args.isDefault === true || anySender === null;
		if (makeDefault) {
			await clearDefault(ctx);
		}

		return await ctx.db.insert('campaignSenders', {
			email,
			displayName: args.displayName?.trim() || undefined,
			isEnabled: args.isEnabled ?? true,
			isDefault: makeDefault,
			createdBy: session.userId,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Edit a curated sender's display name / enabled state. The address itself is
 * immutable (remove + re-add to change it, so the domain re-verifies).
 */
export const update = authedMutation({
	args: {
		id: v.id('campaignSenders'),
		displayName: v.optional(v.string()),
		isEnabled: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireCampaignSendersManage(ctx);
		const sender = await ctx.db.get(args.id);
		if (!sender) {
			throwNotFound('Campaign sender');
		}
		const patch: Partial<Doc<'campaignSenders'>> = { updatedAt: Date.now() };
		if (args.displayName !== undefined) {
			patch.displayName = args.displayName.trim() || undefined;
		}
		if (args.isEnabled !== undefined) {
			patch.isEnabled = args.isEnabled;
		}
		await ctx.db.patch(args.id, patch);
		return args.id;
	},
});

/**
 * Make one sender the default for new campaigns, clearing the previous default.
 */
export const setDefault = authedMutation({
	args: { id: v.id('campaignSenders') },
	handler: async (ctx, args) => {
		await requireCampaignSendersManage(ctx);
		const sender = await ctx.db.get(args.id);
		if (!sender) {
			throwNotFound('Campaign sender');
		}
		await clearDefault(ctx);
		await ctx.db.patch(args.id, { isDefault: true, updatedAt: Date.now() });
		return args.id;
	},
});

/**
 * Remove a curated sender. Removing the default leaves the list with no default
 * until an admin sets a new one (a campaign then falls back to a custom sender
 * only if the toggle allows it).
 */
export const remove = authedMutation({
	args: { id: v.id('campaignSenders') },
	handler: async (ctx, args) => {
		await requireCampaignSendersManage(ctx);
		const sender = await ctx.db.get(args.id);
		if (!sender) {
			throwNotFound('Campaign sender');
		}
		await ctx.db.delete(args.id);
		return { success: true };
	},
});

/**
 * Idempotent bootstrap seed, run FROM THE SEND PATH (`campaigns/campaigns.ts`
 * sendNow, `campaigns/scheduling.ts` schedule) right before pre-flight: if no
 * curated senders exist yet and the org has a `defaultFromEmail` on a verified
 * domain, create one enabled default row from `defaultFromName`/`defaultFromEmail`.
 *
 * Without this, upgrading an existing deployment (toggle OFF, list empty, no
 * management UI until d2/d3) would brick every campaign send with
 * `sender_not_allowed` and no admin-clickable recovery. Wiring it into the
 * mutation send path (not a query — a query can't write) means the first send
 * self-heals the common case where the campaign uses the org default address.
 *
 * A plain helper rather than a mutation: it runs as whichever member is sending
 * (`campaigns:send`), so it must NOT require `campaigns:manage`. Safe to call
 * repeatedly — a no-op once any sender exists. Returns whether it inserted.
 */
export async function seedDefaultSenderIfNeeded(ctx: MutationCtx): Promise<boolean> {
	const existing = await ctx.db.query('campaignSenders').first();
	if (existing) {
		return false;
	}
	const settings = await ctx.db.query('instanceSettings').first();
	const email = settings?.defaultFromEmail ? normalizeEmail(settings.defaultFromEmail) : undefined;
	if (!email || !isValidEmail(email)) {
		return false;
	}
	const status = await checkEmailDomainVerification(ctx, email);
	if (!status.verified) {
		return false;
	}
	const now = Date.now();
	await ctx.db.insert('campaignSenders', {
		email,
		displayName: settings?.defaultFromName?.trim() || undefined,
		isEnabled: true,
		isDefault: true,
		createdBy: SYSTEM_SEED_CREATED_BY,
		createdAt: now,
		updatedAt: now,
	});
	return true;
}

/**
 * Clear the current default flag (at most one row carries it). Bounded scan —
 * the curated list is tiny.
 */
async function clearDefault(ctx: MutationCtx): Promise<void> {
	// bounded: curated list is intentionally tiny (a handful of addresses).
	const all = await ctx.db.query('campaignSenders').take(200);
	for (const s of all) {
		if (s.isDefault) {
			await ctx.db.patch(s._id, { isDefault: false, updatedAt: Date.now() });
		}
	}
}
