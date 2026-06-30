<script setup lang="ts">
defineProps<{
	answer: string;
	sources: Array<{ id: string; title: string; entryType: string }>;
}>();
</script>

<template>
	<div class="space-y-4">
		<!-- Answer -->
		<div class="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
			{{ answer }}
		</div>

		<!-- Sources -->
		<div v-if="sources.length > 0" class="pt-3 border-t border-border-subtle">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
				Sources
			</p>
			<div class="flex flex-wrap gap-2">
				<QuerySourceCitation
					v-for="source in sources"
					:key="source.id"
					:id="source.id"
					:title="source.title"
					:entry-type="source.entryType"
				/>
			</div>
		</div>
	</div>
</template>
