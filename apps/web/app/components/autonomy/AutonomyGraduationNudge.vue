<script setup lang="ts">
/**
 * Graduation NUDGE — turns the shadow scorecard + the weekly loosening
 * suggestions into an ACTIONABLE offer the operator accepts explicitly.
 *
 * Autonomy only ever widens by a deliberate action, so this component never
 * changes anything itself: it emits `accept-offer` (enable auto-send for a
 * proven sender) or `accept-suggestion` (apply a looser category threshold), and
 * the parent page calls the corresponding mutation. Presentational + prop-driven
 * for straightforward unit testing.
 */
interface ScorecardOffer {
	category: string;
	sender: string;
	wouldHaveSent: number;
	matched: number;
	matchRate: number;
	offerGraduation: boolean;
}

interface GraduationSuggestion {
	_id: string;
	category: string;
	currentThreshold: number;
	suggestedThreshold: number;
	evidence: { approved: number; sampleSize: number; rejectionRate: number };
}

interface Props {
	offers?: ScorecardOffer[] | null;
	suggestions?: GraduationSuggestion[] | null;
	// Key ("category::sender" or suggestion id) currently being accepted.
	pendingKey?: string | null;
}
const { t, locale } = useI18n();

const props = withDefaults(defineProps<Props>(), {
	offers: () => [],
	suggestions: () => [],
	pendingKey: null,
});

const emit = defineEmits<{
	'accept-offer': [payload: { category: string; sender: string }];
	'accept-suggestion': [payload: { suggestionId: string }];
}>();

// Only the scorecard slices that have actually earned graduation.
const readyOffers = computed(() => (props.offers ?? []).filter((o) => o.offerGraduation));

const hasNudges = computed(
	() => readyOffers.value.length > 0 || (props.suggestions ?? []).length > 0
);

const pct = (n: number) =>
	new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 }).format(n);
</script>

<template>
	<UiCard v-if="hasNudges" data-testid="graduation-nudge" class="border-brand/40">
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox icon="lucide:trending-up" size="sm" variant="brand" />
			<div>
				<h3 class="text-base font-medium text-text-primary">
					{{ t('components.autonomy.autonomyGraduationNudge.title') }}
				</h3>
				<p class="text-xs text-text-tertiary">
					{{ t('components.autonomy.autonomyGraduationNudge.body') }}
				</p>
			</div>
		</div>

		<ul class="space-y-3">
			<!-- Per-sender scorecard offers -->
			<li
				v-for="offer in readyOffers"
				:key="`offer-${offer.category}-${offer.sender}`"
				data-testid="graduation-offer"
				class="flex items-center justify-between gap-4 rounded-lg border border-border-subtle p-3"
			>
				<div class="min-w-0">
					<p class="text-sm text-text-primary">
						<I18nT
							keypath="components.autonomy.autonomyGraduationNudge.offer"
							tag="span"
							scope="global"
						>
							<template #matched>
								<strong>{{ offer.matched }}</strong>
							</template>
							<template #total>
								<strong>{{ offer.wouldHaveSent }}</strong>
							</template>
							<template #category>{{ offer.category }}</template>
							<template #sender>
								<strong class="break-all">{{ offer.sender }}</strong>
							</template>
						</I18nT>
					</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{
							t('components.autonomy.autonomyGraduationNudge.matchRate', {
								rate: pct(offer.matchRate),
							})
						}}
					</p>
				</div>
				<UiButton
					size="sm"
					class="shrink-0"
					:disabled="pendingKey === `${offer.category}::${offer.sender}`"
					@click="emit('accept-offer', { category: offer.category, sender: offer.sender })"
				>
					{{ t('components.autonomy.autonomyGraduationNudge.enableAutoSend') }}
				</UiButton>
			</li>

			<!-- Category threshold-loosening suggestions -->
			<li
				v-for="s in suggestions ?? []"
				:key="`sugg-${s._id}`"
				data-testid="graduation-suggestion"
				class="flex items-center justify-between gap-4 rounded-lg border border-border-subtle p-3"
			>
				<div class="min-w-0">
					<p class="text-sm text-text-primary">
						<I18nT
							keypath="components.autonomy.autonomyGraduationNudge.suggestion"
							tag="span"
							scope="global"
						>
							<template #category>
								<strong>{{ s.category }}</strong>
							</template>
							<template #current>
								<strong>{{ pct(s.currentThreshold) }}</strong>
							</template>
							<template #suggested>
								<strong>{{ pct(s.suggestedThreshold) }}</strong>
							</template>
						</I18nT>
					</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{
							t('components.autonomy.autonomyGraduationNudge.suggestionEvidence', {
								approved: s.evidence.approved,
								sampleSize: s.evidence.sampleSize,
								rate: pct(s.evidence.rejectionRate),
							})
						}}
					</p>
				</div>
				<UiButton
					size="sm"
					class="shrink-0"
					:disabled="pendingKey === s._id"
					@click="emit('accept-suggestion', { suggestionId: s._id })"
				>
					{{ t('common.apply') }}
				</UiButton>
			</li>
		</ul>
	</UiCard>
</template>
