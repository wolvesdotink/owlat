<script setup lang="ts">
import { RENDERABLE_CARD_TYPES } from '~/composables/widgets';
import {
	type CardSize,
	type EditableRule,
	type RuleRole,
	type SavedRule,
	DAY_OF_WEEK_LABELS,
	ROLE_OPTIONS,
	createEmptyRule,
	normalizeRules,
	toEditableRules,
} from '~/composables/useDashboardRules';

interface CardEntry {
	type: string;
	size: CardSize;
}

interface AvailableCard {
	type: string;
	label: string;
	description: string;
}

const props = defineProps<{
	isOpen: boolean;
	cards: Array<CardEntry & { pinned?: boolean }>;
	availableCards: AvailableCard[];
	rules?: SavedRule[];
}>();

const emit = defineEmits<{
	close: [];
	save: [pinnedCards: CardEntry[], rules: SavedRule[]];
}>();

const { t } = useI18n();

const editableCards = ref<CardEntry[]>([]);
const editableRules = ref<EditableRule[]>([]);

watch(
	() => props.isOpen,
	(open) => {
		if (open) {
			editableCards.value = props.cards.map((c) => ({
				type: c.type,
				size: c.size,
			}));
			editableRules.value = toEditableRules(props.rules);
		}
	}
);

const addedTypes = computed(() => new Set(editableCards.value.map((c) => c.type)));

const availableToAdd = computed(() => {
	// Defensive: never offer a card type that has no renderer — adding it would
	// draw "Unknown card type". The backend's getAvailableCards is already
	// renderable-only, this guards against drift.
	return props.availableCards.filter(
		(c) => !addedTypes.value.has(c.type) && RENDERABLE_CARD_TYPES.has(c.type)
	);
});

function getCardLabel(type: string): string {
	return props.availableCards.find((c) => c.type === type)?.label ?? type;
}

function getCardDescription(type: string): string {
	return props.availableCards.find((c) => c.type === type)?.description ?? '';
}

function removeCard(index: number) {
	editableCards.value.splice(index, 1);
}

function addCard(type: string) {
	editableCards.value.push({
		type,
		size: 'small',
	});
}

function moveCard(fromIndex: number, direction: 'up' | 'down') {
	const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
	if (toIndex < 0 || toIndex >= editableCards.value.length) return;
	const cards = [...editableCards.value];
	const temp = cards[fromIndex]!;
	cards[fromIndex] = cards[toIndex]!;
	cards[toIndex] = temp;
	editableCards.value = cards;
}

// ── Adaptive rules ────────────────────────────────────────────────────────

// Card types that have a renderer and can be added to a rule.
const renderableCardOptions = computed(() =>
	props.availableCards.filter((c) => RENDERABLE_CARD_TYPES.has(c.type))
);

function addRule() {
	editableRules.value.push(createEmptyRule());
}

function removeRule(index: number) {
	editableRules.value.splice(index, 1);
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

function handleSave() {
	emit('save', [...editableCards.value], normalizeRules(editableRules.value));
	emit('close');
}

function handleCancel() {
	emit('close');
}

// The three shorthand size letters, the weekday initials and the role names are
// display-only: the stored values stay the untranslated `CardSize` / weekday
// number / role literals.
const sizeOptions = computed<{ value: CardSize; label: string }[]>(() => [
	{ value: 'small', label: t('components.dashboard.dashboardEditor.sizes.small') },
	{ value: 'medium', label: t('components.dashboard.dashboardEditor.sizes.medium') },
	{ value: 'large', label: t('components.dashboard.dashboardEditor.sizes.large') },
]);

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
	<Teleport to="body">
		<Transition name="slide">
			<div v-if="isOpen" class="fixed inset-0 z-50">
				<!-- Backdrop -->
				<div class="absolute inset-0 bg-bg-deep/80 backdrop-blur-sm" @click="handleCancel" />

				<!-- Panel -->
				<div
					class="absolute right-0 top-0 bottom-0 w-full max-w-md bg-bg-base border-l border-border-subtle shadow-lg flex flex-col"
				>
					<!-- Header -->
					<div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
						<h2 class="text-lg font-semibold text-text-primary">
							{{ t('components.dashboard.dashboardEditor.title') }}
						</h2>
						<button
							class="p-1.5 rounded-lg hover:bg-bg-surface-hover transition-colors text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							@click="handleCancel"
							:aria-label="t('common.close')"
						>
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</div>

					<!-- Content -->
					<div class="flex-1 overflow-y-auto">
						<!-- Current Cards -->
						<div class="px-5 py-4">
							<h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
								{{ t('components.dashboard.dashboardEditor.activeCards') }}
							</h3>

							<div v-if="editableCards.length === 0" class="py-6 text-center">
								<p class="text-sm text-text-tertiary">{{ t('components.dashboard.dashboardEditor.noCards') }}</p>
							</div>

							<div v-else class="space-y-2">
								<div
									v-for="(card, index) in editableCards"
									:key="`${card.type}-${index}`"
									class="flex items-center gap-2 rounded-lg bg-surface-2 shadow-surface-1 px-3 py-2.5"
								>
									<!-- Reorder buttons -->
									<div class="flex flex-col gap-0.5 shrink-0">
										<button
											:disabled="index === 0"
											class="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover disabled:opacity-30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											@click="moveCard(index, 'up')"
											:aria-label="t('components.dashboard.dashboardEditor.moveUp')"
										>
											<Icon name="lucide:chevron-up" class="w-3.5 h-3.5" />
										</button>
										<button
											:disabled="index === editableCards.length - 1"
											class="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover disabled:opacity-30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											@click="moveCard(index, 'down')"
											:aria-label="t('components.dashboard.dashboardEditor.moveDown')"
										>
											<Icon name="lucide:chevron-down" class="w-3.5 h-3.5" />
										</button>
									</div>

									<!-- Card info -->
									<div class="flex-1 min-w-0">
										<p class="text-sm font-medium text-text-primary truncate">
											{{ getCardLabel(card.type) }}
										</p>
										<p class="text-xs text-text-tertiary truncate">
											{{ getCardDescription(card.type) }}
										</p>
									</div>

									<!-- Size selector -->
									<div class="flex items-center gap-0.5 shrink-0">
										<button
											v-for="opt in sizeOptions"
											:key="opt.value"
											class="px-2 py-1 text-xs font-medium rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:class="
												card.size === opt.value
													? 'bg-text-primary text-text-inverse'
													: 'bg-bg-surface text-text-secondary hover:text-text-primary'
											"
											@click="card.size = opt.value"
										>
											{{ opt.label }}
										</button>
									</div>

									<!-- Remove button -->
									<button
										class="p-1 rounded-lg text-text-tertiary hover:text-error hover:bg-error/10 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										@click="removeCard(index)"
										:aria-label="t('components.dashboard.dashboardEditor.removeCard')"
									>
										<Icon name="lucide:x" class="w-4 h-4" />
									</button>
								</div>
							</div>
						</div>

						<!-- Available Cards -->
						<div v-if="availableToAdd.length > 0" class="px-5 py-4 border-t border-border-subtle">
							<h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
								{{ t('components.dashboard.dashboardEditor.addCards') }}
							</h3>
							<div class="space-y-2">
								<button
									v-for="card in availableToAdd"
									:key="card.type"
									class="w-full flex items-center gap-3 rounded-lg border border-dashed border-border-subtle px-3 py-2.5 hover:border-brand hover:bg-brand-soft transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click="addCard(card.type)"
								>
									<div
										class="flex items-center justify-center w-7 h-7 rounded-lg bg-bg-surface text-text-tertiary shrink-0"
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
									</div>
									<div class="min-w-0 flex-1">
										<p class="text-sm font-medium text-text-primary">{{ card.label }}</p>
										<p class="text-xs text-text-tertiary truncate">{{ card.description }}</p>
									</div>
								</button>
							</div>
						</div>

						<!-- Adaptive Rules -->
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

							<div v-if="editableRules.length === 0" class="py-4 text-center">
								<p class="text-sm text-text-tertiary">
									{{ t('components.dashboard.dashboardEditor.noRules') }}
								</p>
							</div>

							<div v-else class="space-y-3">
								<div
									v-for="(rule, ruleIndex) in editableRules"
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
											aria-label="Remove rule"
											@click="removeRule(ruleIndex)"
										>
											<Icon name="lucide:trash-2" class="w-4 h-4" />
										</button>
									</div>

									<!-- Time range -->
									<div>
										<p class="text-xs font-medium text-text-secondary mb-1">{{ t('components.dashboard.dashboardEditor.timeRange') }}</p>
										<div class="flex items-center gap-2">
											<input
												v-model="rule.timeStart"
												type="time"
												class="input input-sm flex-1"
												:aria-label="t('components.dashboard.dashboardEditor.startTime')"
											/>
											<span class="text-text-tertiary text-xs">{{ t('components.dashboard.dashboardEditor.timeRangeTo') }}</span>
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
										<p class="text-xs font-medium text-text-secondary mb-1">{{ t('components.dashboard.dashboardEditor.daysLabel') }}</p>
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
										<p class="text-xs font-medium text-text-secondary mb-1">{{ t('components.dashboard.dashboardEditor.roleLabel') }}</p>
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
										<p class="text-xs font-medium text-text-secondary mb-1">{{ t('components.dashboard.dashboardEditor.cardsToShow') }}</p>
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
												{{ card.label }}
											</button>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>

					<!-- Footer -->
					<div class="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
						<UiButton variant="ghost" @click="handleCancel">{{ t('common.cancel') }}</UiButton>
						<UiButton @click="handleSave">
						{{ t('components.dashboard.dashboardEditor.saveLayout') }}
					</UiButton>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
	transition: opacity var(--motion-moderate) var(--ease-spring);
}

.slide-enter-active > div:last-child,
.slide-leave-active > div:last-child {
	transition: transform var(--motion-moderate) var(--ease-spring);
}

.slide-enter-from,
.slide-leave-to {
	opacity: 0;
}

.slide-enter-from > div:last-child,
.slide-leave-to > div:last-child {
	transform: translateX(100%);
}
</style>
