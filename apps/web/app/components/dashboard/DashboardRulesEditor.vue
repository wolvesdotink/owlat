<script setup lang="ts">
/**
 * The adaptive-rules half of the dashboard editor: the list of time/day/role
 * rules and, per rule, the cards it swaps in.
 *
 * Extracted from `DashboardEditor.vue` (which was over the ~500-LOC cap) along
 * the seam the panel already had: the editor above owns the ALWAYS-pinned cards,
 * this owns the CONDITIONAL ones. The rules array is edited in place through
 * `v-model`, so the editor still holds the single draft it normalizes on save.
 */
import { RENDERABLE_CARD_TYPES } from '~/composables/widgets';
import {
	type CardSize,
	type EditableRule,
	type RuleRole,
	DAY_OF_WEEK_LABELS,
	ROLE_OPTIONS,
	createEmptyRule,
} from '~/composables/useDashboardRules';
import { useDashboardCardCopy } from '~/composables/useDashboardCardCopy';

interface AvailableCard {
	type: string;
	label: string;
	description: string;
}

const props = defineProps<{
	availableCards: AvailableCard[];
	/** The shared size shorthands, resolved once by the editor. */
	sizeOptions: { value: CardSize; label: string }[];
}>();

const rules = defineModel<EditableRule[]>({ required: true });

const { t } = useI18n();
// Same render boundary as the editor above: the backend names cards in English,
// the operator reads them in their own language.
const { cardLabel } = useDashboardCardCopy();

function getCardLabel(type: string): string {
	const card = props.availableCards.find((c) => c.type === type);
	return card ? cardLabel(card) : type;
}

// Card types that have a renderer and can be added to a rule.
const renderableCardOptions = computed(() =>
	props.availableCards.filter((c) => RENDERABLE_CARD_TYPES.has(c.type))
);

function addRule() {
	rules.value.push(createEmptyRule());
}

function removeRule(index: number) {
	rules.value.splice(index, 1);
}

function toggleRuleDay(rule: EditableRule, day: number) {
	const idx = rule.dayOfWeek.indexOf(day);
	if (idx === -1) rule.dayOfWeek.push(day);
	else rule.dayOfWeek.splice(idx, 1);
}

function setRuleRole(rule: EditableRule, role: RuleRole | '') {
	rule.role = role;
}

function ruleCardsToAdd(rule: EditableRule): AvailableCard[] {
	const present = new Set(rule.cards.map((c) => c.type));
	return renderableCardOptions.value.filter((c) => !present.has(c.type));
}

function addRuleCard(rule: EditableRule, type: string) {
	if (rule.cards.some((c) => c.type === type)) return;
	rule.cards.push({ type, size: 'small' });
}

function removeRuleCard(rule: EditableRule, index: number) {
	rule.cards.splice(index, 1);
}

// The weekday initials and the role names are display-only: the stored values
// stay the untranslated weekday number / role literals.
const DAY_KEYS: Record<number, string> = {
	0: 'sun',
	1: 'mon',
	2: 'tue',
	3: 'wed',
	4: 'thu',
	5: 'fri',
	6: 'sat',
};

const dayOptions = computed(() =>
	DAY_OF_WEEK_LABELS.map((day) => ({
		value: day.value,
		label: t(`components.dashboard.dashboardEditor.days.${DAY_KEYS[day.value]}`),
	}))
);
const roleOptions = computed(() =>
	ROLE_OPTIONS.map((role) => ({
		value: role.value,
		label: t(`components.dashboard.dashboardEditor.roles.${role.value || 'any'}`),
	}))
);
</script>

<template>
	<div class="px-5 py-4 border-t border-border-subtle">
		<div class="flex items-center justify-between mb-1">
			<h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide">
				{{ t('components.dashboard.dashboardEditor.adaptiveRules') }}
			</h3>
			<UiButton variant="ghost" size="sm" @click="addRule">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-3.5 h-3.5" />
				</template>
				{{ t('components.dashboard.dashboardEditor.addRule') }}
			</UiButton>
		</div>
		<p class="text-xs text-text-tertiary mb-3">
			{{ t('components.dashboard.dashboardEditor.adaptiveRulesHint') }}
		</p>

		<div v-if="rules.length === 0" class="py-4 text-center">
			<p class="text-sm text-text-tertiary">
				{{ t('components.dashboard.dashboardEditor.noRules') }}
			</p>
		</div>

		<div v-else class="space-y-3">
			<div
				v-for="(rule, ruleIndex) in rules"
				:key="`rule-${ruleIndex}`"
				class="rounded-lg bg-surface-2 shadow-surface-1 p-3 space-y-3"
			>
				<!-- Rule header: priority + remove -->
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-2">
						<label class="text-xs font-medium text-text-secondary">{{
							t('components.dashboard.dashboardEditor.priority')
						}}</label>
						<input
							v-model.number="rule.priority"
							type="number"
							class="input input-sm w-16"
							:aria-label="t('components.dashboard.dashboardEditor.rulePriority')"
						/>
					</div>
					<button
						class="p-1 rounded-lg text-text-tertiary hover:text-error hover:bg-error/10 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:aria-label="t('components.dashboard.dashboardEditor.removeRule')"
						@click="removeRule(ruleIndex)"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</button>
				</div>

				<!-- Time range -->
				<div>
					<p class="text-xs font-medium text-text-secondary mb-1">
						{{ t('components.dashboard.dashboardEditor.timeRange') }}
					</p>
					<div class="flex items-center gap-2">
						<input
							v-model="rule.timeStart"
							type="time"
							class="input input-sm flex-1"
							:aria-label="t('components.dashboard.dashboardEditor.startTime')"
						/>
						<span class="text-text-tertiary text-xs">{{
							t('components.dashboard.dashboardEditor.timeRangeTo')
						}}</span>
						<input
							v-model="rule.timeEnd"
							type="time"
							class="input input-sm flex-1"
							:aria-label="t('components.dashboard.dashboardEditor.endTime')"
						/>
					</div>
				</div>

				<!-- Days of week -->
				<div>
					<p class="text-xs font-medium text-text-secondary mb-1">
						{{ t('components.dashboard.dashboardEditor.daysLabel') }}
					</p>
					<div class="flex flex-wrap gap-1">
						<button
							v-for="day in dayOptions"
							:key="day.value"
							type="button"
							class="px-2 py-1 text-xs font-medium rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:class="
								rule.dayOfWeek.includes(day.value)
									? 'bg-text-primary text-text-inverse'
									: 'bg-bg-surface text-text-secondary hover:text-text-primary'
							"
							@click="toggleRuleDay(rule, day.value)"
						>
							{{ day.label }}
						</button>
					</div>
				</div>

				<!-- Role -->
				<div>
					<p class="text-xs font-medium text-text-secondary mb-1">
						{{ t('components.dashboard.dashboardEditor.roleLabel') }}
					</p>
					<div class="flex flex-wrap gap-1">
						<button
							v-for="opt in roleOptions"
							:key="opt.value || 'any'"
							type="button"
							class="px-2 py-1 text-xs font-medium rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:class="
								rule.role === opt.value
									? 'bg-text-primary text-text-inverse'
									: 'bg-bg-surface text-text-secondary hover:text-text-primary'
							"
							@click="setRuleRole(rule, opt.value)"
						>
							{{ opt.label }}
						</button>
					</div>
				</div>

				<!-- Cards in this rule -->
				<div>
					<p class="text-xs font-medium text-text-secondary mb-1">
						{{ t('components.dashboard.dashboardEditor.cardsToShow') }}
					</p>
					<div v-if="rule.cards.length === 0" class="text-xs text-text-tertiary mb-2">
						{{ t('components.dashboard.dashboardEditor.emptyRuleHint') }}
					</div>
					<div v-else class="space-y-1.5 mb-2">
						<div
							v-for="(card, cardIndex) in rule.cards"
							:key="`${card.type}-${cardIndex}`"
							class="flex items-center gap-2 rounded-md bg-surface-3 shadow-surface-1 px-2 py-1.5"
						>
							<p class="flex-1 min-w-0 text-xs font-medium text-text-primary truncate">
								{{ getCardLabel(card.type) }}
							</p>
							<div class="flex items-center gap-0.5 shrink-0">
								<button
									v-for="opt in sizeOptions"
									:key="opt.value"
									class="px-1.5 py-0.5 text-2xs font-medium rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									:class="
										card.size === opt.value
											? 'bg-text-primary text-text-inverse'
											: 'bg-bg-elevated text-text-secondary hover:text-text-primary'
									"
									@click="card.size = opt.value"
								>
									{{ opt.label }}
								</button>
							</div>
							<button
								class="p-0.5 rounded text-text-tertiary hover:text-error transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								:aria-label="t('components.dashboard.dashboardEditor.removeRuleCard')"
								@click="removeRuleCard(rule, cardIndex)"
							>
								<Icon name="lucide:x" class="w-3.5 h-3.5" />
							</button>
						</div>
					</div>
					<div v-if="ruleCardsToAdd(rule).length > 0" class="flex flex-wrap gap-1">
						<button
							v-for="card in ruleCardsToAdd(rule)"
							:key="card.type"
							type="button"
							class="flex items-center gap-1 px-2 py-1 text-xs rounded border border-dashed border-border-subtle text-text-secondary hover:border-brand hover:text-brand transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							@click="addRuleCard(rule, card.type)"
						>
							<Icon name="lucide:plus" class="w-3 h-3" />
							{{ cardLabel(card) }}
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
