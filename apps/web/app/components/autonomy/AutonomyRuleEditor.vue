<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { categoryIcon as resolveCategoryIcon } from '~/utils/agentCategories';

interface AutonomyRule {
	_id: string;
	category: string;
	autoApproveThreshold: number;
	maxDailyAutoActions: number;
	currentDailyCount?: number;
	isEnabled: boolean;
	createdAt?: number;
	updatedAt?: number;
}

interface Props {
	rule: AutonomyRule;
	isNew?: boolean;
}

const { t, locale } = useI18n();

const props = withDefaults(defineProps<Props>(), {
	isNew: false,
});

const emit = defineEmits<{
	saved: [];
	deleted: [];
	cancelled: [];
}>();

const { run: upsertRule } = useBackendOperation(api.autonomy.upsertRule, {
	label: () => t('components.autonomy.autonomyRuleEditor.saveOperation'),
});
const { run: deleteRule } = useBackendOperation(api.autonomy.deleteRule, {
	label: () => t('components.autonomy.autonomyRuleEditor.deleteOperation'),
});

const categories = computed(() =>
	['support', 'sales', 'billing', 'feature_request', 'complaint', 'spam', 'internal', 'other'].map(
		(value) => ({
			value,
			label: t(`components.autonomy.autonomyRuleEditor.categories.${value}`),
		})
	)
);

// Form state
const form = reactive({
	category: props.rule.category,
	autoApproveThreshold: props.rule.autoApproveThreshold,
	maxDailyAutoActions: props.rule.maxDailyAutoActions,
	enabled: props.rule.isEnabled,
});

const isSaving = ref(false);
const isDeleting = ref(false);
const showDeleteConfirm = ref(false);

const categoryIcon = computed(() => resolveCategoryIcon(form.category));
const categoryLabel = computed(() => {
	const cat = categories.value.find((c) => c.value === form.category);
	return cat?.label ?? titleCaseEnum(form.category);
});

const thresholdPercent = computed(() =>
	new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 }).format(
		form.autoApproveThreshold
	)
);

const dailyCountDisplay = computed(() =>
	t('components.autonomy.autonomyRuleEditor.todayCount', {
		current: props.rule.currentDailyCount ?? 0,
		max: form.maxDailyAutoActions,
	})
);

const handleSave = async () => {
	isSaving.value = true;
	try {
		const result = await upsertRule({
			category: form.category,
			autoApproveThreshold: form.autoApproveThreshold,
			maxDailyAutoActions: form.maxDailyAutoActions,
			isEnabled: form.enabled,
		});
		if (!result.ok) return;
		emit('saved');
	} finally {
		isSaving.value = false;
	}
};

const handleDelete = async () => {
	if (!props.rule._id) return;
	isDeleting.value = true;
	try {
		const result = await deleteRule({ ruleId: props.rule._id as Id<'autonomyRules'> });
		if (!result.ok) return;
		emit('deleted');
	} finally {
		isDeleting.value = false;
		showDeleteConfirm.value = false;
	}
};

const handleCancel = () => {
	emit('cancelled');
};
</script>

<template>
	<UiCard>
		<!-- Header -->
		<div class="flex items-center justify-between mb-6">
			<div v-if="isNew" class="flex items-center gap-3 flex-1">
				<UiIconBox :icon="categoryIcon" size="sm" variant="surface" />
				<select v-model="form.category" class="input flex-1 max-w-xs">
					<option value="" disabled>
						{{ t('components.autonomy.autonomyRuleEditor.categoryPlaceholder') }}
					</option>
					<option v-for="cat in categories" :key="cat.value" :value="cat.value">
						{{ cat.label }}
					</option>
				</select>
			</div>
			<div v-else class="flex items-center gap-3">
				<UiIconBox :icon="categoryIcon" size="sm" variant="surface" />
				<div>
					<h3 class="text-base font-medium text-text-primary">{{ categoryLabel }}</h3>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<UiToggle
					v-model="form.enabled"
					:label="form.enabled ? t('common.enabled') : t('common.disabled')"
					size="sm"
				/>
			</div>
		</div>

		<!-- Settings -->
		<div class="space-y-5">
			<!-- Auto-Approve Threshold -->
			<div>
				<div class="flex items-center justify-between mb-2">
					<label class="text-sm font-medium text-text-primary">
						{{ t('components.autonomy.autonomyRuleEditor.thresholdLabel') }}
					</label>
					<span class="text-sm font-mono text-brand bg-brand-subtle px-2 py-0.5 rounded">
						{{ thresholdPercent }}
					</span>
				</div>
				<p class="text-xs text-text-tertiary mb-2">
					{{ t('components.autonomy.autonomyRuleEditor.thresholdHint') }}
				</p>
				<input
					v-model.number="form.autoApproveThreshold"
					type="range"
					min="0"
					max="1"
					step="0.05"
					class="w-full h-2 bg-bg-surface rounded-lg appearance-none cursor-pointer accent-brand"
				/>
				<div class="flex justify-between text-xs text-text-tertiary mt-1">
					<span>{{ t('components.autonomy.autonomyRuleEditor.thresholdMin') }}</span>
					<span>{{ t('components.autonomy.autonomyRuleEditor.thresholdMax') }}</span>
				</div>
			</div>

			<!-- Max Daily Auto-Actions -->
			<div>
				<label class="text-sm font-medium text-text-primary">
					{{ t('components.autonomy.autonomyRuleEditor.maxDailyLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-1 mb-2">
					{{ t('components.autonomy.autonomyRuleEditor.maxDailyHint') }}
				</p>
				<div class="flex items-center gap-4">
					<input
						v-model.number="form.maxDailyAutoActions"
						type="number"
						min="0"
						max="10000"
						class="input w-32"
						placeholder="50"
					/>
					<span v-if="!isNew" class="text-xs text-text-tertiary">
						{{ dailyCountDisplay }}
					</span>
				</div>
			</div>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-between mt-6 pt-4 border-t border-border-subtle">
			<div>
				<button
					v-if="!isNew"
					class="text-sm text-error hover:text-error/80 transition-colors"
					:disabled="isDeleting"
					@click="showDeleteConfirm = true"
				>
					{{ t('components.autonomy.autonomyRuleEditor.deleteRule') }}
				</button>
				<button
					v-else
					class="text-sm text-text-secondary hover:text-text-primary transition-colors"
					@click="handleCancel"
				>
					{{ t('common.cancel') }}
				</button>
			</div>
			<UiButton class="gap-2" :disabled="isSaving || (!form.category && isNew)" @click="handleSave">
				<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
				<Icon v-else name="lucide:save" class="w-4 h-4" />
				{{
					isNew
						? t('components.autonomy.autonomyRuleEditor.createRule')
						: t('components.autonomy.autonomyRuleEditor.saveChanges')
				}}
			</UiButton>
		</div>

		<!-- Delete Confirmation -->
		<UiModal :open="showDeleteConfirm" size="sm" @update:open="showDeleteConfirm = $event">
			<div class="flex items-center gap-3 mb-4">
				<UiIconBox icon="lucide:alert-triangle" size="sm" variant="error" />
				<h3 class="text-lg font-medium text-text-primary">
					{{ t('components.autonomy.autonomyRuleEditor.deleteRule') }}
				</h3>
			</div>
			<p class="text-sm text-text-secondary">
				<I18nT
					keypath="components.autonomy.autonomyRuleEditor.deleteConfirm"
					tag="span"
					scope="global"
				>
					<template #category>
						<strong>{{ categoryLabel }}</strong>
					</template>
				</I18nT>
			</p>
			<template #footer>
				<UiButton variant="secondary" @click="showDeleteConfirm = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="danger" class="gap-2" :disabled="isDeleting" @click="handleDelete">
					<UiSpinner v-if="isDeleting" size="xs" tone="inverse" />
					{{ t('common.delete') }}
				</UiButton>
			</template>
		</UiModal>
	</UiCard>
</template>
