<script setup lang="ts">
/**
 * THE CELL GRID — stream x mailbox provider, one row per cell.
 *
 * Four facts per cell and no more: the share it carries, the state it is in, THE
 * BINDING CONSTRAINT, and THE LAST DECISION REASON. Those are the four questions
 * an operator actually has, and every one of them is READ off the controller's
 * own audit row rather than recomputed — a second implementation of the
 * precedence ladder on this side could disagree with the one that moved the
 * share.
 *
 * A TABLE, NOT A GRID OF CARDS. This is tabular data: fifteen rows with the same
 * four columns, sorted, compared across. Rendering it as cards would cost the
 * row/column semantics a screen-reader user navigates it by, for no gain.
 *
 * NOTHING UNMEASURED IS ALARMING. A cell the ramp has not taken over and a cell
 * holding for evidence are both NEUTRAL — a working deployment spends most of
 * its life in exactly those states (plan D2/D10).
 */
import {
	bindingConstraint,
	rampCellLabel,
	rampCellStatus,
	shareLabel,
	type RampCellControl,
} from '~/utils/deliverabilityRamp';

const props = defineProps<{
	cells: readonly RampCellControl[];
	/** The cell whose drill-down is open, by key. */
	selectedCellKey: string | null;
	labelledBy: string;
}>();

/**
 * Status decided ONCE per row. The template needs it three times — the tone
 * class, the `data-state` hook and the label — and calling the classifier once
 * per use makes three chances for them to describe different states if the
 * classifier ever stops being pure.
 */
const rows = computed(() =>
	props.cells.map((cell) => ({
		cell,
		status: rampCellStatus(cell),
		constraint: bindingConstraint(cell),
	}))
);

const emit = defineEmits<{ select: [cellKey: string] }>();

const { t } = useI18n();

/**
 * The per-cell vocabulary in `utils/deliverabilityRamp` carries i18n keys rather
 * than sentences (the registry convention for module-scope definitions); a plain
 * string is still accepted so a value with nothing to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const TONE_CLASS = {
	ok: 'border-success/40 text-success',
	attention: 'border-warning/40 text-warning',
	neutral: 'border-border-subtle text-text-secondary',
} as const;
</script>

<template>
	<div class="overflow-x-auto">
		<table class="w-full text-sm" :aria-labelledby="labelledBy" data-testid="ramp-cells-grid">
			<thead>
				<tr class="text-left text-xs uppercase tracking-wide text-text-secondary">
					<th scope="col" class="py-2 pr-4 font-medium">
						{{ t('components.delivery.rampCellsGrid.columns.cell') }}
					</th>
					<th scope="col" class="py-2 pr-4 font-medium">
						{{ t('components.delivery.rampCellsGrid.columns.ownShare') }}
					</th>
					<th scope="col" class="py-2 pr-4 font-medium">
						{{ t('components.delivery.rampCellsGrid.columns.state') }}
					</th>
					<th scope="col" class="py-2 pr-4 font-medium">
						{{ t('components.delivery.rampCellsGrid.columns.holdingItBack') }}
					</th>
					<th scope="col" class="py-2 font-medium">
						{{ t('components.delivery.rampCellsGrid.columns.lastDecision') }}
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="{ cell, status, constraint } in rows"
					:key="cell.cellKey"
					class="border-t border-border-subtle align-top"
					:data-testid="`ramp-cell-${cell.cellKey}`"
					:data-selected="cell.cellKey === selectedCellKey ? 'true' : 'false'"
				>
					<th scope="row" class="py-3 pr-4 text-left font-normal text-text-primary">
						<button
							type="button"
							class="text-left underline-offset-2 hover:underline"
							:aria-expanded="cell.cellKey === selectedCellKey"
							:data-testid="`ramp-cell-open-${cell.cellKey}`"
							@click="emit('select', cell.cellKey)"
						>
							{{ localized(rampCellLabel(cell.cell)) }}
						</button>
					</th>
					<td class="py-3 pr-4 text-text-primary" data-testid="ramp-cell-share">
						{{ shareLabel(cell.ownShare) }}
					</td>
					<td class="py-3 pr-4">
						<span
							class="rounded-full border px-2 py-0.5 text-xs"
							:class="TONE_CLASS[status.tone]"
							:data-state="status.key"
							data-testid="ramp-cell-state"
						>
							{{ localized(status.label) }}
						</span>
					</td>
					<td class="py-3 pr-4 text-text-secondary" data-testid="ramp-cell-constraint">
						{{ localized(constraint) }}
					</td>
					<td class="py-3 text-text-secondary" data-testid="ramp-cell-reason">
						{{
							cell.lastDecision === null
								? t('components.delivery.rampCellsGrid.noDecisionYet')
								: cell.lastDecision.message
						}}
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
