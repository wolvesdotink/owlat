<script setup lang="ts">
/**
 * Knowledge-graph dashboard (audit item p9-graph-dashboard).
 *
 * A read-only force-directed view of the knowledge graph plus its analytics
 * insight layer. Route-gated on `ai.knowledge.analytics` via `requiresFeature`
 * (the global feature middleware bounces a direct deep-link when the flag is off);
 * the <KnowledgeGraphView> also gates its own render and skips every Convex read
 * until the flag resolves on, so this is defence-in-depth, not the only gate.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.knowledge.graph.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'ai.knowledge.analytics',
});
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8 space-y-6">
		<UiPageHeader
			:title="t('dashboard.knowledge.graph.title')"
			:description="t('dashboard.knowledge.graph.subtitle')"
		>
			<template #actions>
				<UiButton variant="secondary" to="/dashboard/knowledge" class="gap-2">
					<Icon name="lucide:list" class="w-4 h-4" />
					{{ t('dashboard.knowledge.graph.listView') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<KnowledgeGraphView />
	</div>
</template>
