<script setup lang="ts">
const props = defineProps<{
	id: string;
	entryType: string;
	title: string;
	content: string;
	confidence: number;
	tags?: string[];
	sourceType: string;
	createdAt: number;
}>();

const { typeVariant, typeIcon, typeLabel, sourceIcon, sourceLabel, confidenceBgColor, formatConfidence, truncate, confidenceVariant } = useKnowledgeGraph();

const formattedDate = computed(() => {
	const date = new Date(props.createdAt);
	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
});

const displayTags = computed(() => (props.tags ?? []).slice(0, 3));
const hasMoreTags = computed(() => (props.tags ?? []).length > 3);
</script>

<template>
	<NuxtLink
		:to="`/dashboard/knowledge/${id}`"
		class="block group"
	>
		<div
			class="flex items-start gap-4 p-4 rounded-xl border border-border-subtle bg-bg-elevated hover:border-brand/40 transition-colors"
		>
			<!-- Type icon -->
			<div
				class="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
				:class="{
					'bg-brand-subtle text-brand': typeVariant(entryType) === 'default',
					'bg-warning/10 text-warning': typeVariant(entryType) === 'warning',
					'bg-bg-surface text-text-secondary': typeVariant(entryType) === 'neutral',
					'bg-success-subtle text-success': typeVariant(entryType) === 'success',
					'bg-error/10 text-error': typeVariant(entryType) === 'error',
				}"
			>
				<Icon :name="typeIcon(entryType)" class="w-5 h-5" />
			</div>

			<!-- Content -->
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 mb-1">
					<h3 class="text-sm font-semibold text-text-primary truncate group-hover:text-brand transition-colors">
						{{ title }}
					</h3>
					<span
						class="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wide"
						:class="{
							'bg-brand-subtle text-brand': typeVariant(entryType) === 'default',
							'bg-warning/10 text-warning': typeVariant(entryType) === 'warning',
							'bg-bg-surface text-text-tertiary': typeVariant(entryType) === 'neutral',
							'bg-success-subtle text-success': typeVariant(entryType) === 'success',
							'bg-error/10 text-error': typeVariant(entryType) === 'error',
						}"
					>
						{{ typeLabel(entryType) }}
					</span>
				</div>

				<p class="text-sm text-text-secondary line-clamp-2">
					{{ truncate(content) }}
				</p>

				<!-- Bottom row -->
				<div class="flex items-center gap-3 mt-2.5 text-xs text-text-tertiary">
					<!-- Confidence -->
					<div class="flex items-center gap-1.5">
						<UiProgressBar
							class="w-12"
							size="sm"
							:value="confidence * 100"
							:variant="confidenceVariant(confidence)"
							aria-label="Confidence"
						/>
						<span>{{ formatConfidence(confidence) }}</span>
					</div>

					<!-- Source -->
					<div class="flex items-center gap-1">
						<Icon :name="sourceIcon(sourceType)" class="w-3 h-3" />
						<span>{{ sourceLabel(sourceType) }}</span>
					</div>

					<!-- Tags -->
					<template v-if="displayTags.length > 0">
						<span class="text-border-subtle">|</span>
						<div class="flex items-center gap-1">
							<span
								v-for="tag in displayTags"
								:key="tag"
								class="px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary"
							>
								{{ tag }}
							</span>
							<span v-if="hasMoreTags" class="text-text-tertiary">+{{ (tags ?? []).length - 3 }}</span>
						</div>
					</template>

					<!-- Date -->
					<span class="ml-auto">{{ formattedDate }}</span>
				</div>
			</div>
		</div>
	</NuxtLink>
</template>
