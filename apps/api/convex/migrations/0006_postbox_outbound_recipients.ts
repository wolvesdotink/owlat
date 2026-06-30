/**
 * ADR-0012 — Migrate `mailMessages.outbound` from the legacy single-state
 * shape to the per-recipient + derived aggregate shape.
 *
 * Legacy shape:
 *   outbound: {
 *     state: 'queued' | 'sending' | 'sent' | 'bounced' | 'failed' | 'pending';
 *     mtaJobId?: string;
 *     sentAt?: number;
 *     bounceMessage?: string;
 *   }
 *
 * New shape:
 *   outbound: {
 *     state: 'queued' | 'sent' | 'bounced' | 'failed' | 'partial';
 *     recipients: Array<{
 *       idx: number;
 *       address: string;
 *       mtaJobId: string;
 *       state: 'queued' | 'sent' | 'bounced' | 'failed';
 *       sentAt?: number;
 *       bounceMessage?: string;
 *       errorCode?: string;
 *     }>;
 *   }
 *
 * Multi-recipient legacy rows backfill as single-element arrays — per-recipient
 * history was never stored, so reconstructing it is impossible. The aggregate
 * `state` matches what the UI rendered before; user-visible state is preserved.
 *
 * Legacy `'sending'` re-maps to `'queued'`; legacy `'pending'` re-maps to
 * `'sent'` (per the ADR — neither literal was actually written by any path,
 * so the mapping is defensive).
 *
 * Idempotent: rows already in the new shape are skipped.
 *
 * Pre-prod, so this runs synchronously against `.collect()`. If this ever
 * ships against production-sized tables, paginate via `withIndex` scoped to
 * a marker field.
 *
 * Note: Convex schema validation may block reading rows in the legacy shape
 * once the new validator is deployed. If that happens, temporarily widen the
 * `outbound` validator to accept both shapes during the migration window,
 * run this migration, then narrow back to the new-only validator.
 */

import { internalMutation } from '../_generated/server';

type LegacyState = 'queued' | 'sending' | 'sent' | 'bounced' | 'failed' | 'pending';
type NewRecipientState = 'queued' | 'sent' | 'bounced' | 'failed';

// The pre-ADR-0012 `outbound` shape — no longer in the schema's `Doc` type,
// so rows are read through this view to reach the legacy fields.
interface LegacyOutbound {
	state?: LegacyState;
	recipients?: unknown;
	mtaJobId?: string;
	sentAt?: number;
	bounceMessage?: string;
}

function mapLegacyState(state: LegacyState): NewRecipientState {
	if (state === 'sending') return 'queued';
	if (state === 'pending') return 'sent';
	return state;
}

export const run = internalMutation({
	args: {},
	handler: async (ctx) => {
		let migrated = 0;
		let alreadyNew = 0;
		let skipped = 0;

		const rows = await ctx.db.query('mailMessages').collect();
		for (const row of rows) {
			const ob = row.outbound as unknown as LegacyOutbound | undefined;
			if (!ob) continue;

			// Already in new shape — skip.
			if (Array.isArray(ob.recipients)) {
				alreadyNew++;
				continue;
			}

			// Legacy shape: single state, no recipients[].
			const legacyState = ob.state as LegacyState | undefined;
			if (!legacyState) {
				skipped++;
				continue;
			}

			const mapped = mapLegacyState(legacyState);
			const primaryAddress = row.toAddresses[0] ?? '';
			const mtaJobId =
				typeof ob.mtaJobId === 'string' && ob.mtaJobId.length > 0
					? ob.mtaJobId
					: `pb-${row._id}-0`;

			await ctx.db.patch(row._id, {
				outbound: {
					state: mapped,
					recipients: [
						{
							idx: 0,
							address: primaryAddress,
							mtaJobId,
							state: mapped,
							...(typeof ob.sentAt === 'number' ? { sentAt: ob.sentAt } : {}),
							...(typeof ob.bounceMessage === 'string'
								? { bounceMessage: ob.bounceMessage }
								: {}),
						},
					],
				},
				updatedAt: Date.now(),
			});
			migrated++;
		}

		return { migrated, alreadyNew, skipped };
	},
});
