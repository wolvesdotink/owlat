<script setup lang="ts">
/**
 * An item's stance in Answer mode (plan §6): how the reply takes it on —
 * Accept / Decline / Defer / Ask, or Answer / Decline / Defer, by what kind of
 * ask it is (`stanceChoicesFor`) — and "File missing" when the draft says a
 * file is attached that is not. "Addressed in draft" is the item's own state
 * chip (BriefItem overlays it from the plan).
 *
 * A choice is the owner's: the drafter follows it, and accepting a price, a
 * deadline or a concession is only ever this choice, never the email's ask.
 * The default stance answers without committing; for a decision (no "Answer"
 * among its choices) no choice shows as made until the owner makes one.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { stanceChoicesFor } from '@owlat/shared/threadBriefRules';
import type { ResponsePlanView } from '~/utils/responsePlan';

const props = defineProps<{ item: BriefItemView; plan: ResponsePlanView }>();

const { t } = useI18n();
const choices = computed(() => stanceChoicesFor(props.item.intent, props.item.facets));
const current = computed(() => props.plan.stanceOf(props.item.id));
const isFileMissing = computed(() => props.plan.fileMissing.value.has(props.item.id));
</script>

<template>
	<div class="mt-1.5 flex flex-wrap items-center gap-2" data-testid="brief-item-plan">
		<div
			class="inline-flex overflow-hidden rounded-md border border-border-subtle"
			role="radiogroup"
			:aria-label="t('components.answer.plan.stanceGroup', { item: item.text })"
		>
			<button
				v-for="choice in choices"
				:key="choice"
				type="button"
				role="radio"
				:aria-checked="current === choice"
				class="border-l border-border-subtle px-2 py-0.5 text-xs transition-colors first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:class="
					current === choice
						? 'bg-bg-surface font-medium text-text-primary'
						: 'text-text-tertiary hover:text-text-primary'
				"
				:data-stance="choice"
				@click="plan.setStance(item.id, choice)"
			>
				{{ t(`components.answer.plan.stance.${choice}`) }}
			</button>
		</div>
		<span
			v-if="isFileMissing"
			class="rounded-full bg-warning/10 px-1.5 text-2xs font-medium text-warning"
			data-testid="brief-item-file-missing"
		>
			{{ t('components.answer.plan.fileMissing') }}
		</span>
	</div>
</template>
