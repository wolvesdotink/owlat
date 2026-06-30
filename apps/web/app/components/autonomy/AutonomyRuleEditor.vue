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

const props = withDefaults(defineProps<Props>(), {
	isNew: false,
});

const emit = defineEmits<{
	saved: [];
	deleted: [];
	cancelled: [];
}>();

const { run: upsertRule } = useBackendOperation(api.autonomy.upsertRule, {
	label: 'Save autonomy rule',
});
const { run: deleteRule } = useBackendOperation(api.autonomy.deleteRule, {
	label: 'Delete autonomy rule',
});

const categories = [
	{ value: 'support', label: 'Support' },
	{ value: 'sales', label: 'Sales' },
	{ value: 'billing', label: 'Billing' },
	{ value: 'feature_request', label: 'Feature Request' },
	{ value: 'complaint', label: 'Complaint' },
	{ value: 'spam', label: 'Spam' },
	{ value: 'internal', label: 'Internal' },
	{ value: 'other', label: 'Other' },
];

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
	const cat = categories.find((c) => c.value === form.category);
	return cat?.label ?? form.category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
});

const thresholdPercent = computed(() => Math.round(form.autoApproveThreshold * 100));

const dailyCountDisplay = computed(() => {
	const current = props.rule.currentDailyCount ?? 0;
	return `${current} / ${form.maxDailyAutoActions}`;
});

const handleSave = async () => {
	isSaving.value = true;
	try {
		const result = await upsertRule({
			category: form.category,
			autoApproveThreshold: form.autoApproveThreshold,
			maxDailyAutoActions: form.maxDailyAutoActions,
			isEnabled: form.enabled,
		});
		if (result === undefined) return;
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
		if (result === undefined) return;
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
				<select
					v-model="form.category"
					class="input flex-1 max-w-xs"
				>
					<option value="" disabled>Select category</option>
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
				<UiToggle v-model="form.enabled" :label="form.enabled ? 'Enabled' : 'Disabled'" size="sm" />
			</div>
		</div>

		<!-- Settings -->
		<div class="space-y-5">
			<!-- Auto-Approve Threshold -->
			<div>
				<div class="flex items-center justify-between mb-2">
					<label class="text-sm font-medium text-text-primary">Auto-Approve Threshold</label>
					<span class="text-sm font-mono text-brand bg-brand-subtle px-2 py-0.5 rounded">
						{{ thresholdPercent }}%
					</span>
				</div>
				<p class="text-xs text-text-tertiary mb-2">
					Minimum confidence score required for the agent to auto-approve actions in this category.
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
					<span>0% (all auto)</span>
					<span>100% (all manual)</span>
				</div>
			</div>

			<!-- Max Daily Auto-Actions -->
			<div>
				<label class="text-sm font-medium text-text-primary">Max Daily Auto-Actions</label>
				<p class="text-xs text-text-tertiary mt-1 mb-2">
					Maximum number of actions the agent can auto-approve per day for this category.
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
						Today: {{ dailyCountDisplay }}
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
					Delete Rule
				</button>
				<button
					v-else
					class="text-sm text-text-secondary hover:text-text-primary transition-colors"
					@click="handleCancel"
				>
					Cancel
				</button>
			</div>
			<button
				class="btn btn-primary gap-2"
				:disabled="isSaving || (!form.category && isNew)"
				@click="handleSave"
			>
				<div
					v-if="isSaving"
					class="w-4 h-4 border-2 border-bg-deep border-t-transparent rounded-full animate-spin"
				/>
				<Icon v-else name="lucide:save" class="w-4 h-4" />
				{{ isNew ? 'Create Rule' : 'Save Changes' }}
			</button>
		</div>

		<!-- Delete Confirmation -->
		<Teleport to="body">
			<Transition name="fade">
				<div
					v-if="showDeleteConfirm"
					class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					@click.self="showDeleteConfirm = false"
				>
					<div class="bg-bg-elevated border border-border-subtle rounded-xl p-6 max-w-sm mx-4 shadow-xl">
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:alert-triangle" size="sm" variant="error" />
							<h3 class="text-lg font-medium text-text-primary">Delete Rule</h3>
						</div>
						<p class="text-sm text-text-secondary mb-6">
							Are you sure you want to delete the autonomy rule for
							<strong>{{ categoryLabel }}</strong>? This action cannot be undone.
						</p>
						<div class="flex justify-end gap-3">
							<button
								class="btn btn-secondary"
								@click="showDeleteConfirm = false"
							>
								Cancel
							</button>
							<button
								class="btn bg-error text-white hover:bg-error/90 gap-2"
								:disabled="isDeleting"
								@click="handleDelete"
							>
								<div
									v-if="isDeleting"
									class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
								/>
								Delete
							</button>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</UiCard>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>
