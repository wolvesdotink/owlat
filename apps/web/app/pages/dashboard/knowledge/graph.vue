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
useHead({ title: 'Knowledge Graph Explorer — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'ai.knowledge.analytics',
});
</script>

<template>
	<div class="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
		<!-- Header -->
		<div class="flex items-start justify-between gap-4">
			<div class="flex items-start gap-4">
				<div class="w-12 h-12 rounded-xl bg-brand-subtle flex items-center justify-center flex-shrink-0">
					<Icon name="lucide:share-2" class="w-6 h-6 text-brand" />
				</div>
				<div>
					<h1 class="text-xl font-bold text-text-primary">Graph Explorer</h1>
					<p class="text-sm text-text-secondary mt-0.5">
						Explore the knowledge graph — hubs, communities, and how entries connect.
					</p>
				</div>
			</div>
			<NuxtLink to="/dashboard/knowledge" class="btn btn-secondary gap-2 flex-shrink-0">
				<Icon name="lucide:list" class="w-4 h-4" />
				List view
			</NuxtLink>
		</div>

		<KnowledgeGraphView />
	</div>
</template>
