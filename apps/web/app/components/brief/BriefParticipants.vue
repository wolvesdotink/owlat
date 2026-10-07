<script setup lang="ts">
/**
 * "People": who is in the thread and in what role (plan §4.1). Someone who
 * only appears on cc is said so, because an ask addressed to them is not
 * yours (plan §8).
 */
import type { ParticipantView } from '../../../../api/convex/mail/interpret/briefShape';
import BriefSection from './BriefSection.vue';

const props = defineProps<{ participants: readonly ParticipantView[] }>();

const { t } = useI18n();

/** Us once, last; everyone else in the order the brief gives. */
const people = computed(() => {
	const others = props.participants.filter((p) => !p.isUs);
	const us = props.participants.find((p) => p.isUs);
	return us ? [...others, us] : others;
});

function nameOf(p: ParticipantView): string {
	return p.isUs ? t('components.brief.people.you') : p.name || p.email || '';
}
</script>

<template>
	<BriefSection
		v-if="people.length > 0"
		:title="t('components.brief.people.title')"
		heading-id="brief-people"
	>
		<ul class="flex flex-wrap gap-x-3 gap-y-1.5 text-xs" data-testid="brief-people">
			<li v-for="(p, i) in people" :key="p.email ?? i" class="flex items-center gap-1.5">
				<UiAvatar
					:name="nameOf(p)"
					:email="p.email"
					deterministic-color
					size="xs"
					aria-hidden="true"
				/>
				<span class="text-text-primary" :title="p.email">{{ nameOf(p) }}</span>
				<span v-if="!p.isUs" class="text-text-tertiary">{{
					t(`components.brief.people.role.${p.role}`)
				}}</span>
			</li>
		</ul>
	</BriefSection>
</template>
