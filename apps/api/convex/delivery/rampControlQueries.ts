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
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';
import { defaultRampPreset, type RampPreset } from '@owlat/shared/deliverabilityIndependence';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { loadRouteStatesByCell } from '../lib/deliverabilityRouteState';
import { relayConfiguration } from './relayConfiguration';
import { bindsPhaseLadder, resolveRampDegradation } from './ramp/degradation';
import {
	loadRampDeploymentPresence,
	loadReferenceArmPresence,
	withReferenceArm,
} from './rampIntegrationPresence';
import type { RampDecisionReason } from './ramp/controllerTypes';
import type { RampGateId } from './ramp/gateTypes';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from './deliverabilityValidators';

/** How many decisions the drill-down timeline shows at once. */
const DECISION_PAGE_SIZE = 50;
/**
 * How many time-ordered rows the grid reads to find fifteen cells' latest
 * decisions. One tick writes at most one row per cell, so a page this size
 * covers several ticks and the per-cell fallback below almost never fires.
 */
const LATEST_DECISION_SCAN_LIMIT = 120;

export interface RampCellDecisionView {
	readonly at: number;
	readonly fromShare: number;
	readonly toShare: number;
	readonly direction: 'increase' | 'decrease' | 'hold';
	// THE CLOSED UNIONS, NOT `string`. The stored columns are already validated by
	// `rampDecisionReasonValidator` / `rampGateIdValidator`, so widening them at
	// the query boundary would buy nothing and would cost every consumer its
	// exhaustiveness — the Cells grid's reason labels included.
	readonly reason: RampDecisionReason;
	readonly message: string;
	readonly failedGate: RampGateId | null;
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
	/**
	 * WHICH DIAL THIS CELL'S RAMP IS, as the TICK reads it — `bindsPhaseLadder`
	 * over the cell's own degradation, the same answer `readsShareDial` gives the
	 * mutation that writes the audit row.
	 *
	 * PER CELL AND NOT `isRelayConfigured`, because they disagree exactly where it
	 * matters: a relay that is configured but carried nothing this window leaves
	 * the controller ramping by PACE, so copy cut on the configuration would tell
	 * an operator a pin bounds the climbing dial while the dial actually climbing
	 * is the warm-up pace, which no pin can bound — and the audit row would say
	 * the opposite back to them later. Whether a relay is configured is a second,
	 * separate fact and stays on `isRelayConfigured` for the doors that cut on it.
	 */
	readonly isShareRamped: boolean;
	/** The controller's own last word on this cell — the binding constraint. */
	readonly lastDecision: RampCellDecisionView | null;
}

export interface RampControlsView {
	readonly generatedAt: number;
	readonly referenceTransportId: string | null;
	/**
	 * WHETHER ANY RELAY IS CONFIGURED — HALF of the fact `resetCellPhase` cuts a
	 * share on, carried here so the copy beside the rung buttons cannot promise a
	 * different move from the one the server makes.
	 *
	 * HALF, NOT THE WHOLE. The door cuts on `hasSecondSender` — configured OR
	 * MEASURED — so this field answers the reset copy only together with the
	 * cell's own `isShareRamped`. Reading it alone is what let the screen say a
	 * share is held on a cell whose reference arm the tick still measures; the
	 * component crosses the two rather than either side guessing.
	 *
	 * DELIBERATELY NOT `referenceTransportId !== null`. That names the SINGLE
	 * second arm and is null on a deployment with two relays connected, where the
	 * reset really does cut — a screen reading it as "standalone" would tell that
	 * operator their share stays where it is while 75% of the cell moves.
	 */
	readonly isRelayConfigured: boolean;
	/** The global kill switch (`instanceSettings.isRampControllerPaused`). */
	readonly isControllerPaused: boolean;
	readonly presets: Readonly<Partial<Record<DeliverabilityStream, RampPreset>>>;
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

/**
 * The newest decision for EVERY cell, in one bounded page.
 *
 * ONE PAGE, NOT FIFTEEN READS. The controller writes at most one row per cell
 * per tick, so the newest few ticks of `by_org_time` already contain every
 * cell's latest row; walking that page newest-first and keeping the first row
 * seen per cell answers the whole grid from a single index read.
 *
 * The per-cell fallback is kept for the case the page cannot answer: a cell that
 * has been quiet for longer than the page covers (an unmanaged cell that was
 * briefly on the ramp months ago, say) still shows its real last decision rather
 * than reading as "never evaluated" because a busier cell crowded it out.
 */
async function latestDecisionsByCell(
	ctx: QueryCtx,
	organizationId: string,
	cellKeys: readonly string[]
): Promise<Map<string, Doc<'mixDecisions'>>> {
	const page = await ctx.db
		.query('mixDecisions')
		.withIndex('by_org_time', (q) => q.eq('organizationId', organizationId))
		.order('desc')
		.take(LATEST_DECISION_SCAN_LIMIT);
	const byCell = new Map<string, Doc<'mixDecisions'>>();
	for (const row of page) {
		if (!byCell.has(row.cell)) byCell.set(row.cell, row);
	}
	const missing = cellKeys.filter((cellKey) => !byCell.has(cellKey));
	const fallbacks = await Promise.all(
		missing.map(async (cellKey) => ({
			cellKey,
			row: await latestDecision(ctx, organizationId, cellKey),
		}))
	);
	for (const { cellKey, row } of fallbacks) {
		if (row !== null) byCell.set(cellKey, row);
	}
	return byCell;
}

// all-members: the ramp's own position and the operator settings on it. No
// credentials, no recipient identities; the organization comes from the session.
export const getRampControls = authedQuery({
	args: {},
	handler: async (ctx): Promise<RampControlsView> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const now = Date.now();
		const settings = await ctx.db.query('instanceSettings').first();
		// TWO READINGS OF ONE LIST, from one read of it. "Which single arm is the
		// reference one" and the reset door's own fact "is there a second sender at
		// all" have different answers on a two-relay deployment, and the screen shows
		// both — so the pair is derived where the rule lives rather than scanning
		// `providerRoutes` twice for two views of the same configuration.
		const { referenceTransportId, isRelayConfigured } = await relayConfiguration(ctx);
		const presetRows = await ctx.db
			.query('rampStreamPresets')
			.withIndex('by_org_stream', (q) => q.eq('organizationId', organizationId))
			.take(8);
		const presets: Partial<Record<DeliverabilityStream, RampPreset>> = {};
		for (const row of presetRows) presets[row.stream] = row.preset;

		const byCell = await loadRouteStatesByCell(ctx, organizationId);
		// ONE DEPLOYMENT READING FOR THE WHOLE GRID. The presence map is a property
		// of the deployment, not of a cell, so folding it once and crossing it with
		// each cell's own reference arm is the controller's own sequence — and
		// asking it fifteen times would let two rows of one screen answer off two
		// different readings.
		const deploymentPresence = await loadRampDeploymentPresence(ctx, { organizationId, now });

		const cellKeys = allDeliverabilityCells().map(deliverabilityCellKey);
		const decisionsByCell = await latestDecisionsByCell(ctx, organizationId, cellKeys);

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
				isShareRamped: bindsPhaseLadder(
					resolveRampDegradation({
						presence: withReferenceArm(
							deploymentPresence,
							await loadReferenceArmPresence(ctx, { organizationId, cell, now })
						),
						provider: cell.destinationProvider,
					})
				),
				lastDecision: decisionView(decisionsByCell.get(cellKey) ?? null),
			});
		}

		return {
			generatedAt: now,
			referenceTransportId,
			isRelayConfigured,
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
	readonly failedGate: RampGateId | null;
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
		// `noticeAt` is written ONLY on rows carrying a notice, so this range read
		// pages over retreats alone — no fixed scan window, and therefore no age at
		// which a retreat silently stops being reachable.
		const rows = await ctx.db
			.query('mixDecisions')
			.withIndex('by_org_notice', (q) => q.eq('organizationId', organizationId).gt('noticeAt', 0))
			.order('desc')
			.take(limit);
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
		}
		return notices;
	},
});
