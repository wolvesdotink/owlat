/**
 * THE CELLS AND CONTROLS SCREENS' READS (plan D12, D14, P3-6).
 *
 * THE BINDING CONSTRAINT IS NOT DERIVED HERE — IT IS READ. The controller
 * already records, for every evaluation including the no-ops, which rung bounded
 * the cell (`mixDecisions.reason`) and one human-readable sentence saying so
 * (`mixDecisions.message`). Recomputing "what is holding this cell back" on the
 * read side would be a second implementation of the precedence ladder that could
 * disagree with the one that actually moved the share — which is the exact class
 * of bug D5 was written about, one layer up. So the grid shows the last
 * decision, verbatim.
 *
 * A CELL WITH NO DECISIONS IS NOT AN ERROR. Most cells in most deployments have
 * never been ramp-managed; they render as "not on the ramp yet", calmly, with no
 * warning styling and nothing to fix (plan D2).
 */

import { v } from 'convex/values';
import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import { defaultRampPreset, type RampPreset } from '@owlat/shared/deliverabilityIndependence';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { referenceRelayTransportId } from './alignmentPreflight';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from './deliverabilityValidators';

/** How many decisions the drill-down timeline shows at once. */
const DECISION_PAGE_SIZE = 50;
/** How far back the notices feed looks, and how many rows it will scan. */
const NOTICE_SCAN_LIMIT = 200;

export interface RampCellDecisionView {
	readonly at: number;
	readonly fromShare: number;
	readonly toShare: number;
	readonly direction: 'increase' | 'decrease' | 'hold';
	readonly reason: string;
	readonly message: string;
	readonly failedGate: string | null;
	/** Present only on a decrease with a named cause — the admin notice (D12). */
	readonly adminNotice: string | null;
	readonly frozenUntil: number | null;
}

export interface RampCellControlView {
	readonly cell: DeliverabilityCell;
	readonly cellKey: string;
	/** `false` for a cell the ramp has never taken over. Never an error state. */
	readonly isRampManaged: boolean;
	readonly ownShare: number;
	readonly phaseCeiling: number | null;
	readonly cleanStreak: number;
	readonly graduatedAt: number | null;
	readonly frozenUntil: number | null;
	readonly isPaused: boolean;
	readonly pinnedShare: number | null;
	/** The controller's own last word on this cell — the binding constraint. */
	readonly lastDecision: RampCellDecisionView | null;
}

export interface RampControlsView {
	readonly generatedAt: number;
	readonly referenceTransportId: string | null;
	/** The global kill switch (`instanceSettings.isRampControllerPaused`). */
	readonly isControllerPaused: boolean;
	readonly presets: Readonly<Record<string, RampPreset>>;
	readonly defaultPreset: RampPreset;
	readonly cells: readonly RampCellControlView[];
}

function decisionView(row: Doc<'mixDecisions'> | null): RampCellDecisionView | null {
	if (row === null) return null;
	return {
		at: row.at,
		fromShare: row.fromShare,
		toShare: row.toShare,
		direction: row.direction,
		reason: row.reason,
		message: row.message,
		failedGate: row.failedGate ?? null,
		adminNotice: row.adminNotice ?? null,
		frozenUntil: row.frozenUntil ?? null,
	};
}

/** The newest decision for one cell — one index read, one row. */
async function latestDecision(
	ctx: QueryCtx,
	organizationId: string,
	cellKey: string
): Promise<Doc<'mixDecisions'> | null> {
	return await ctx.db
		.query('mixDecisions')
		.withIndex('by_org_cell_time', (q) =>
			q.eq('organizationId', organizationId).eq('cell', cellKey)
		)
		.order('desc')
		.first();
}

// all-members: the ramp's own position and the operator settings on it. No
// credentials, no recipient identities; the organization comes from the session.
export const getRampControls = authedQuery({
	args: {},
	handler: async (ctx): Promise<RampControlsView> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const now = Date.now();
		const settings = await ctx.db.query('instanceSettings').first();
		const referenceTransportId = await referenceRelayTransportId(ctx);
		const presetRows = await ctx.db
			.query('rampStreamPresets')
			.withIndex('by_org_stream', (q) => q.eq('organizationId', organizationId))
			.take(8);
		const presets: Record<string, RampPreset> = {};
		for (const row of presetRows) presets[row.stream] = row.preset;

		const routeRows = await ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) => q.eq('organizationId', organizationId))
			.take(128);
		const byCell = new Map<string, Doc<'deliverabilityRouteStates'>>();
		for (const row of routeRows) {
			if (row.stream === undefined) continue;
			byCell.set(`${row.stream}:${row.destinationProvider}`, row);
		}

		const cells: RampCellControlView[] = [];
		for (const cell of allDeliverabilityCells()) {
			const cellKey = deliverabilityCellKey(cell);
			const row = byCell.get(cellKey) ?? null;
			cells.push({
				cell,
				cellKey,
				isRampManaged: row !== null && row.ownShare !== undefined,
				ownShare: resolveOwnShare(row),
				phaseCeiling: row?.phaseCeiling ?? null,
				cleanStreak: row?.cleanStreak ?? 0,
				graduatedAt: row?.graduatedAt ?? null,
				frozenUntil: row?.frozenUntil ?? null,
				isPaused: row?.operatorPausedAt !== undefined,
				pinnedShare: row?.operatorPinnedShare ?? null,
				lastDecision: decisionView(await latestDecision(ctx, organizationId, cellKey)),
			});
		}

		return {
			generatedAt: now,
			referenceTransportId,
			isControllerPaused: settings?.isRampControllerPaused === true,
			presets,
			defaultPreset: defaultRampPreset(referenceTransportId !== null),
			cells,
		};
	},
});

// all-members: one cell's decision timeline — the audit trail behind the share.
export const listCellDecisions = authedQuery({
	args: {
		stream: deliverabilityStreamValidator,
		destinationProvider: destinationProviderValidator,
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<readonly RampCellDecisionView[]> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const cellKey = deliverabilityCellKey({
			stream: args.stream,
			destinationProvider: args.destinationProvider,
		});
		const requested = args.limit ?? DECISION_PAGE_SIZE;
		const limit =
			Number.isFinite(requested) && requested > 0
				? Math.min(Math.floor(requested), DECISION_PAGE_SIZE)
				: DECISION_PAGE_SIZE;
		const rows = await ctx.db
			.query('mixDecisions')
			.withIndex('by_org_cell_time', (q) =>
				q.eq('organizationId', organizationId).eq('cell', cellKey)
			)
			.order('desc')
			.take(limit);
		return rows.flatMap((row) => {
			const view = decisionView(row);
			return view === null ? [] : [view];
		});
	},
});

export interface RampAdminNotice {
	readonly at: number;
	readonly cellKey: string;
	readonly notice: string;
	readonly failedGate: string | null;
	readonly fromShare: number;
	readonly toShare: number;
}

/**
 * EVERY DECREASE NAMES THE GATE THAT BROKE AND WHAT TO DO ABOUT IT (plan D12).
 *
 * The notice text is the controller's own — `rampDecisionAdminNotice` composed
 * it when the decision was made, and it is read back verbatim. Composing a
 * second sentence here would let the screen and the audit row describe the same
 * retreat differently, and the operator would have no way to tell which one the
 * controller actually acted on.
 */
// all-members: retreat notices for the caller's organization, already redacted
// to a cell key and a sentence — no credentials, no recipient identities.
export const listRampAdminNotices = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args): Promise<readonly RampAdminNotice[]> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const requested = args.limit ?? 20;
		const limit =
			Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 50) : 20;
		// Convex indexes cannot be partial, so the notice filter runs over a BOUNDED
		// page of the time-ordered index rather than over the table.
		const rows = await ctx.db
			.query('mixDecisions')
			.withIndex('by_org_time', (q) => q.eq('organizationId', organizationId))
			.order('desc')
			.take(NOTICE_SCAN_LIMIT);
		const notices: RampAdminNotice[] = [];
		for (const row of rows) {
			if (row.adminNotice === undefined) continue;
			notices.push({
				at: row.at,
				cellKey: row.cell,
				notice: row.adminNotice,
				failedGate: row.failedGate ?? null,
				fromShare: row.fromShare,
				toShare: row.toShare,
			});
			if (notices.length >= limit) break;
		}
		return notices;
	},
});
