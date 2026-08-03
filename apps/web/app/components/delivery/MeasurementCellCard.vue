<script setup lang="ts">
/**
 * One ramp cell — (stream × destination provider) — as a read-only card.
 *
 * SHIP THE MEASUREMENT BEFORE THE CONTROL: this card is how a human checks the
 * gates against reality before anything acts on them. It shows the two arms of
 * the cell side by side, every gate's verdict with its numbers, how much the
 * measurement is worth, and the trend across the window.
 *
 * THE STATES ARE THE FEATURE (plan D2/D14), and the column and the invitation
 * are keyed to different facts — the column to what this cell MEASURED, the
 * invitation to what the deployment HAS, so a connected-but-idle relay gets the
 * one column without being offered a relay it already pays for:
 *   - no arm measured here   -> one column. A supported configuration, not a nag.
 *   - no relay configured    -> plus a plain invitation to connect one. It
 *                               arrives as a server improvement code, decided in
 *                               `dashboardConfidence` and never re-derived here.
 *   - a relay that went quiet -> one column WITH relay bars still on the trend,
 *                                and a line saying why the two disagree.
 *   - insufficient data       -> "not enough data yet, N of 400 sends", neutral.
 *   - zero volume             -> an empty, calm cell. Nothing is wrong.
 *
 * Nothing here divides: every rate comes off the server summary verbatim
 * (ADR-0042 / plan D5).
 */
import {
	armMetricRows,
	cellLabel,
	confidenceLabel,
	improvementCopy,
	isZeroVolume,
	ownShareLabel,
	type DeliverabilityDashboardCell,
} from '~/utils/deliverabilityMeasurement';
import { formatNumber, formatShortDate } from '~/utils/formatters';
import { transportIdLabel } from '~/utils/transportState';

const props = defineProps<{
	cell: DeliverabilityDashboardCell;
	referenceTransportId: string | null;
}>();

const title = computed(() => cellLabel(props.cell.cell));
const headingId = computed(() => `measurement-cell-${props.cell.cellKey.replace(':', '-')}`);
const isStandalone = computed(() => props.cell.reference === null);
const isEmpty = computed(() => isZeroVolume(props.cell));
const rows = computed(() => armMetricRows(props.cell.own, props.cell.reference));
// The column heads the RELAY's numbers, so it carries the relay's name rather
// than its stored id. `transportIdLabel` names a built-in kind the way the
// transport card does; a plugin relay it names from its id's LEAF, because the
// catalog's display label is not carried by the dashboard query — the transport
// card, which does read the catalog, may word that one relay differently.
const referenceColumnLabel = computed(() =>
	props.referenceTransportId === null ? 'Comparison' : transportIdLabel(props.referenceTransportId)
);

/**
 * The trend, as COUNTS per day. Rendered as text plus a proportional bar, so it
 * is readable without colour and legible to a screen reader.
 *
 * `widthPercent` is geometry — a bar's length relative to the tallest day — and
 * is deliberately the only division on this screen. It is never shown as a
 * number and never compared against a threshold; every RATE here still comes
 * off the server summary verbatim (plan D5).
 */
const trendPoints = computed(() => {
	const points = props.cell.trend;
	const peak = points.reduce((max, point) => Math.max(max, point.own.sent), 0);
	return points.map((point) => ({
		day: point.day,
		label: formatShortDate(point.day),
		sent: formatNumber(point.own.sent),
		referenceSent: point.reference === null ? null : formatNumber(point.reference.sent),
		widthPercent: peak > 0 ? Math.round((point.own.sent / peak) * 100) : 0,
	}));
});

/**
 * THE ONE STATE THAT LOOKS LIKE A BUG AND IS NOT: relay bars on the chart with
 * no relay column beside them.
 *
 * The arm is what the gates were GIVEN, and they are given a reference arm only
 * where the relay carried this cell in the controller's own span (~24h). The
 * trend answers over the days it plots, so a relay that went quiet three days
 * ago keeps its bars and loses its column — correct on both counts, and
 * unexplained until now. This says it in one line rather than leaving the
 * operator to file a ticket about a column that vanished.
 */
const hasQuietRelayHistory = computed(
	() => isStandalone.value && props.cell.trend.some((point) => point.reference !== null)
);
</script>

<template>
	<UiCard>
		<section :aria-labelledby="headingId" class="space-y-5">
			<header class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 :id="headingId" class="text-base font-semibold text-text-primary">{{ title }}</h3>
					<p class="mt-1 text-sm text-text-secondary">
						Your own server carries
						<span data-testid="measurement-own-share">{{ ownShareLabel(cell) }}</span>
						of this traffic.
					</p>
				</div>
				<span
					class="rounded-full border border-border-subtle px-3 py-1 text-xs text-text-secondary"
					data-testid="measurement-confidence"
					:data-level="cell.confidence.level"
				>
					{{ confidenceLabel(cell.confidence.level) }}
				</span>
			</header>

			<!-- Zero volume: nothing sent, nothing wrong. -->
			<p v-if="isEmpty" data-testid="measurement-empty" class="text-sm text-text-secondary">
				Nothing has been sent in this cell during this window. There is nothing to measure yet, and
				that is fine.
			</p>

			<template v-else>
				<div class="overflow-x-auto">
					<table class="w-full text-sm" data-testid="measurement-arm-table">
						<caption class="sr-only">
							Sending outcomes for
							{{
								title
							}}
							over the selected window
						</caption>
						<thead>
							<tr class="text-left text-xs uppercase tracking-wide text-text-secondary">
								<th scope="col" class="py-2 pr-4 font-medium">Metric</th>
								<th scope="col" class="py-2 pr-4 font-medium">Your server</th>
								<th v-if="!isStandalone" scope="col" class="py-2 font-medium">
									{{ referenceColumnLabel }}
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="row in rows"
								:key="row.key"
								class="border-t border-border-subtle"
								:data-testid="`measurement-metric-${row.key}`"
							>
								<th scope="row" class="py-2 pr-4 text-left font-normal text-text-secondary">
									{{ row.label }}
								</th>
								<td class="py-2 pr-4 text-text-primary" data-testid="measurement-own-value">
									{{ row.ownCount }}
									<span v-if="row.ownRate" class="text-text-secondary">({{ row.ownRate }})</span>
								</td>
								<td
									v-if="!isStandalone"
									class="py-2 text-text-primary"
									data-testid="measurement-reference-value"
								>
									{{ row.referenceCount }}
									<span v-if="row.referenceRate" class="text-text-secondary">
										({{ row.referenceRate }})
									</span>
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<DeliveryMeasurementGateList
					:gates="cell.gates"
					:failed-gate="cell.failedGate"
					:requires-corroboration="cell.requiresCorroboration"
				/>

				<div v-if="trendPoints.length > 0">
					<h4 class="text-sm font-semibold text-text-primary">Trend</h4>
					<p
						v-if="hasQuietRelayHistory"
						data-testid="measurement-quiet-relay"
						class="mt-1 text-sm text-text-secondary"
					>
						Your relay carried this cell earlier in this window but not recently, so the checks had
						nothing to compare against and the comparison column is gone. The days it did carry are
						still plotted below.
					</p>
					<ul class="mt-2 space-y-1" data-testid="measurement-trend">
						<li v-for="point in trendPoints" :key="point.day" class="flex items-center gap-3">
							<span class="w-20 shrink-0 text-xs text-text-secondary">{{ point.label }}</span>
							<span class="h-2 flex-1 rounded-full bg-bg-surface">
								<span
									class="block h-2 rounded-full bg-brand"
									:style="{ width: `${point.widthPercent}%` }"
								/>
							</span>
							<span class="w-28 shrink-0 text-right text-xs text-text-secondary">
								{{ point.sent }} sent<template v-if="point.referenceSent !== null">
									/ {{ point.referenceSent }}</template
								>
							</span>
						</li>
					</ul>
				</div>
			</template>

			<!-- D2/D14: absence lowers confidence and says what would raise it. Calm invitation, never a warning. -->
			<div
				v-if="cell.confidence.improvements.length > 0"
				class="rounded-lg border border-border-subtle p-3"
				data-testid="measurement-improvements"
			>
				<p class="text-sm font-medium text-text-primary">Improve this measurement</p>
				<ul class="mt-1 space-y-1 text-sm text-text-secondary">
					<li
						v-for="improvement in cell.confidence.improvements"
						:key="improvement"
						:data-testid="`measurement-improvement-${improvement}`"
					>
						{{ improvementCopy(improvement) }}
					</li>
				</ul>
			</div>
		</section>
	</UiCard>
</template>
