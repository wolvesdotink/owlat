<script setup lang="ts">
/**
 * "Activity": the latest things that changed the substance of the thread,
 * newest first. A row Owlat saw happen (`recorded`) needs no label; one a
 * person stated (`you said`) or an email reported (`from their email`) says
 * so, because it is a claim rather than an observed event.
 */
import type { ActivityView } from '../../../../api/convex/mail/interpret/briefShape';
import { briefShortDate } from '~/utils/threadBriefContext';
import BriefSection from './BriefSection.vue';

defineProps<{ activity: readonly ActivityView[] }>();

const { t, locale } = useI18n();

function rowText(row: ActivityView): string {
	return row.text?.trim() || t(`components.brief.activity.type.${row.type}`);
}
</script>

<template>
	<BriefSection
		v-if="activity.length > 0"
		:title="t('components.brief.activity.title')"
		heading-id="brief-activity"
	>
		<ul class="text-[13px]" data-testid="brief-activity">
			<li
				v-for="row in activity"
				:key="row.id"
				class="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2.5 py-1 text-text-secondary"
			>
				<span class="font-mono text-xs text-text-tertiary">{{
					briefShortDate(row.eventAt, locale)
				}}</span>
				<span
					>{{ rowText(row) }}
					<span
						v-if="row.provenance !== 'recorded'"
						class="ml-1 rounded border border-border-subtle px-1 text-[10px] text-text-tertiary"
						:title="t(`components.brief.activity.provenanceHint.${row.provenance}`)"
						data-testid="brief-activity-provenance"
						>{{ t(`components.brief.activity.provenance.${row.provenance}`) }}</span
					></span
				>
			</li>
		</ul>
	</BriefSection>
</template>
