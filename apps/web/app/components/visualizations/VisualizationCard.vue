<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	id: Id<'visualizations'>;
	title: string;
	description?: string | null;
	html: string;
	pinned: boolean;
	createdAt: number;
	// Allowlisted dataset key the chart was built from, when it uses live
	// account data. Undefined for illustrative sample-data charts (not
	// refreshable).
	dataQuery?: string | null;
}>();

const emit = defineEmits<{
	toggled: [];
	removed: [];
	refreshed: [];
}>();

const { run: togglePin } = useBackendOperation(api.visualizationAgent.togglePin, {
	label: 'Toggle pin',
});
const { run: remove } = useBackendOperation(api.visualizationAgent.remove, {
	label: 'Remove visualization',
});
const { run: regenerate } = useBackendOperation(api.visualizationAgent.regenerate, {
	label: 'Refresh visualization',
});

const isLiveData = computed(() => !!props.dataQuery);

const isTogglingPin = ref(false);
const isRemoving = ref(false);
const isRefreshing = ref(false);
const showConfirmRemove = ref(false);

const handleRefresh = async () => {
	isRefreshing.value = true;
	const result = await regenerate({ id: props.id });
	isRefreshing.value = false;
	if (result === undefined) return;
	emit('refreshed');
};

const handleTogglePin = async () => {
	isTogglingPin.value = true;
	const result = await togglePin({ id: props.id });
	isTogglingPin.value = false;
	if (result === undefined) return;
	emit('toggled');
};

const handleRemove = async () => {
	isRemoving.value = true;
	const result = await remove({ id: props.id });
	isRemoving.value = false;
	if (result === undefined) return;
	showConfirmRemove.value = false;
	emit('removed');
};
</script>

<template>
	<div class="card overflow-hidden">
		<!-- Header -->
		<div class="flex items-start justify-between mb-4">
			<div class="min-w-0">
				<h3 class="text-text-primary font-medium truncate">{{ title }}</h3>
				<p v-if="description" class="text-sm text-text-secondary mt-0.5 line-clamp-2">
					{{ description }}
				</p>
				<div class="flex items-center gap-2 mt-1">
					<p class="text-xs text-text-tertiary">{{ formatDate(createdAt) }}</p>
					<span
						v-if="isLiveData"
						class="inline-flex items-center gap-1 text-xs text-brand bg-brand-subtle rounded px-1.5 py-0.5"
						title="Built from your real account data"
					>
						<Icon name="lucide:activity" class="w-3 h-3" />
						Live data
					</span>
				</div>
			</div>
			<div class="flex items-center gap-1 flex-shrink-0 ml-3">
				<button
					v-if="isLiveData"
					class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-50"
					title="Refresh with current account data"
					:disabled="isRefreshing"
					@click="handleRefresh"
				>
					<Icon
						name="lucide:refresh-cw"
						class="w-4 h-4"
						:class="{ 'animate-spin': isRefreshing }"
					/>
				</button>
				<button
					class="p-1.5 rounded transition-colors"
					:class="
						pinned
							? 'text-brand bg-brand-subtle hover:bg-brand-subtle/80'
							: 'text-text-tertiary hover:text-text-primary hover:bg-bg-surface'
					"
					:title="pinned ? 'Unpin from dashboard' : 'Pin to dashboard'"
					:disabled="isTogglingPin"
					@click="handleTogglePin"
				>
					<Icon :name="pinned ? 'lucide:pin-off' : 'lucide:pin'" class="w-4 h-4" />
				</button>
				<button
					class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
					title="Remove visualization"
					@click="showConfirmRemove = true"
				>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</button>
			</div>
		</div>

		<!-- Visualization iframe -->
		<VisualizationsVisualizationRenderer :html="html" min-height="250px" />

		<!-- Remove confirmation -->
		<Teleport to="body">
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showConfirmRemove"
					class="fixed inset-0 z-50 flex items-center justify-center p-4"
				>
					<div class="absolute inset-0 bg-black/60" @click="showConfirmRemove = false" />
					<div
						class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-sm"
					>
						<h3 class="text-lg font-semibold text-text-primary mb-2">Remove Visualization</h3>
						<p class="text-sm text-text-secondary mb-6">
							This will permanently delete this visualization. This action cannot be undone.
						</p>
						<div class="flex items-center justify-end gap-3">
							<button class="btn btn-secondary" @click="showConfirmRemove = false">Cancel</button>
							<button
								class="btn bg-error text-white hover:bg-error/90"
								:disabled="isRemoving"
								@click="handleRemove"
							>
								{{ isRemoving ? 'Removing...' : 'Remove' }}
							</button>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
