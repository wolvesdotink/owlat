/**
 * Ask-eagerness dial — persistence surface (Convex queries + mutation).
 *
 * The dial itself (positions, pure policy, instrumentation helpers) lives in
 * `inbox/askEagerness.ts`. This file is only the stored-setting read/write,
 * kept ALONGSIDE Graduated Autonomy (`autonomy.ts`) conceptually — the two read
 * as one coherent trust control — but split into its own module so neither file
 * crosses the file-size ratchet.
 *
 * Single-row upsert (single-org deployment). An ABSENT row = today's behaviour
 * (never a silent default); the reader narrows the stored string to an
 * `EagernessMode` and falls back to `null`/`undefined` on any drift.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { adminQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { asEagernessMode, type EagernessMode } from './askEagerness';

/** Read the ask-eagerness dial for the settings UI. `null` = no setting =
 * today's behaviour (the UI renders its own neutral default). */
export const getAskEagerness = adminQuery({
	args: {},
	handler: async (ctx): Promise<{ mode: EagernessMode | null }> => {
		const row = await ctx.db.query('askEagernessSettings').first();
		return { mode: asEagernessMode(row?.mode) ?? null };
	},
});

/** Session-less read of the dial for the live `clarify` step (which runs inside
 * an action). `null` = today's behaviour. */
export const getAskEagernessInternal = internalQuery({
	args: {},
	handler: async (ctx): Promise<{ mode: EagernessMode | null }> => {
		const row = await ctx.db.query('askEagernessSettings').first();
		return { mode: asEagernessMode(row?.mode) ?? null };
	},
});

/** Set the ask-eagerness dial. Admin-only, mirroring the autonomy-rule guard —
 * the two are one trust control. Single-row upsert. */
// authz: org:manage via requireOrgPermission; org membership via authedMutation.
export const setAskEagerness = authedMutation({
	args: {
		mode: v.union(
			v.literal('cautious'),
			v.literal('balanced'),
			v.literal('confident'),
			v.literal('off')
		),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can change the ask-eagerness setting'
		);
		// Defensive: the arg validator already constrains this, but keep the write
		// strictly within the known modes so a future validator drift can't persist
		// an unknown string the reader would silently ignore.
		const mode = asEagernessMode(args.mode);
		if (!mode) return;
		const now = Date.now();
		const existing = await ctx.db.query('askEagernessSettings').first();
		if (existing) {
			await ctx.db.patch(existing._id, { mode, updatedAt: now });
			return;
		}
		await ctx.db.insert('askEagernessSettings', { mode, updatedAt: now });
	},
});
