<script setup lang="ts">
/**
 * "Latest update": what the newest message says, in at most two sentences,
 * each followed by its source markers (plan §4.1). Nothing renders without a
 * line: short mail and security mail have none by design.
 */
import type { LatestLineView } from '../../../../api/convex/mail/interpret/briefShape';
import { latestCiteRef } from '~/utils/threadBriefView';
import BriefSection from './BriefSection.vue';
import EvidenceMarker from './EvidenceMarker.vue';

defineProps<{
	lines: readonly LatestLineView[];
	/** Changed since the viewer last looked. */
	isNew?: boolean;
	/** Who wrote the newest message and when ("Jonas · today 09:12"). */
	note?: string;
}>();

const { t } = useI18n();
</script>

<template>
	<BriefSection
		v-if="lines.length > 0"
		:title="t('components.brief.latest.title')"
		:note="note"
		heading-id="brief-latest"
	>
		<template v-if="isNew" #badge>
			<span
				class="rounded-full bg-bg-surface px-2 text-2xs font-medium normal-case tracking-normal text-text-secondary"
				>{{ t('components.brief.latest.newSince') }}</span
			>
		</template>
		<p class="text-sm leading-relaxed text-text-primary" data-testid="brief-latest">
			<template v-for="(line, i) in lines" :key="i">
				{{ line.text
				}}<EvidenceMarker
					v-for="(ev, q) in line.evidence.slice(0, 1)"
					:key="q"
					:evidence="ev"
					:cite-ref="latestCiteRef(i)"
					:quote-index="q"
				/>{{ i < lines.length - 1 ? ' ' : '' }}
			</template>
		</p>
	</BriefSection>
</template>
