<script setup lang="ts">
/**
 * "Where things stand": the current value of each fact after everything in
 * the thread (plan §4.1). A value a later message changed shows the old one
 * struck through after the new; two statements that disagree are shown as a
 * pair ("Thu 15 Oct vs Mon 19 Oct"), never silently overwritten (plan §8).
 */
import type { FactView } from '../../../../api/convex/mail/interpret/briefShape';
import { factLabel, factRows } from '~/utils/threadBriefFacts';
import BriefSection from './BriefSection.vue';
import EvidenceMarker from './EvidenceMarker.vue';

const props = defineProps<{
	standing: { facts: readonly FactView[]; isConflicted: boolean; overview?: string };
}>();

const { t, locale } = useI18n();
const rows = computed(() => factRows(props.standing.facts, locale.value));
</script>

<template>
	<BriefSection
		v-if="rows.length > 0 || standing.overview"
		:title="t('components.brief.standing.title')"
		heading-id="brief-standing"
	>
		<p v-if="standing.overview" class="mb-2 text-sm text-text-primary">{{ standing.overview }}</p>
		<ul class="space-y-1" data-testid="brief-standing">
			<li v-for="row in rows" :key="row.fact.id" class="flex gap-2 text-sm text-text-primary">
				<span class="w-24 shrink-0 text-xs leading-5 text-text-tertiary">{{
					factLabel(row.fact.key)
				}}</span>
				<span class="min-w-0">
					<template v-if="row.conflict">
						<b class="font-medium">{{ row.value ?? row.fact.text }}</b
						><EvidenceMarker
							v-if="row.fact.evidence[0]"
							:evidence="row.fact.evidence[0]"
							:cite-ref="row.fact.id"
							:quote-index="0"
						/>
						<span class="mx-1 text-text-tertiary">{{ t('components.brief.standing.versus') }}</span>
						<b class="font-medium">{{ row.conflict.value ?? row.conflict.fact.text }}</b
						><EvidenceMarker
							v-if="row.conflict.fact.evidence[0]"
							:evidence="row.conflict.fact.evidence[0]"
							:cite-ref="row.conflict.fact.id"
							:quote-index="0"
						/>
						<span class="sr-only">{{ t('components.brief.standing.conflict') }}</span>
					</template>
					<template v-else>
						<b v-if="row.value" class="font-medium">{{ row.value }}</b>
						<s v-if="row.previous" class="ml-1 text-text-tertiary"
							><span class="sr-only">{{ t('components.brief.standing.was') }}</span
							>{{ row.previous }}</s
						>
						<span :class="row.value ? 'ml-1 text-text-secondary' : ''">{{ row.fact.text }}</span
						><EvidenceMarker
							v-if="row.fact.evidence[0]"
							:evidence="row.fact.evidence[0]"
							:cite-ref="row.fact.id"
							:quote-index="0"
						/>
					</template>
				</span>
			</li>
		</ul>
	</BriefSection>
</template>
