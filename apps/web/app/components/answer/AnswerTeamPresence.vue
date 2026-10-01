<script setup lang="ts">
import type { PresencePerson } from '~/components/inbox/InboxThreadPresence.vue';

/**
 * Who else is on this Team inbox thread, as one line in Answer mode's top bar
 * (plan §07): "Priya is viewing", "Priya is replying", or "3 people here" with
 * their avatars. A replier comes first, since that is what holds Send.
 * Renders nothing when the person is alone on the thread.
 */
const props = defineProps<{ people: readonly PresencePerson[] }>();
const { t } = useI18n();

const ordered = computed(() =>
	[...props.people].sort((a, b) => Number(b.mode === 'replying') - Number(a.mode === 'replying'))
);
const label = computed(() => {
	const first = ordered.value[0];
	if (!first) return '';
	if (ordered.value.length > 1) {
		return t('components.inbox.inboxThreadPresence.manyHere', { count: ordered.value.length });
	}
	return t(
		first.mode === 'replying'
			? 'components.inbox.inboxThreadPresence.titleReplying'
			: 'components.inbox.inboxThreadPresence.titleViewing',
		{ name: first.name }
	);
});
const replying = computed(() => ordered.value[0]?.mode === 'replying');
</script>

<template>
	<span
		v-if="ordered.length > 0"
		class="inline-flex min-w-0 items-center gap-1.5 text-xs"
		:class="replying ? 'text-warning' : 'text-text-secondary'"
		role="status"
		data-testid="answer-team-presence"
	>
		<span class="flex shrink-0 -space-x-1.5">
			<span v-for="person in ordered.slice(0, 3)" :key="person.userId" class="ui-presence-ring">
				<UiAvatar :name="person.name" :image="person.image" size="xs" deterministic-color />
			</span>
		</span>
		<span class="truncate">{{ label }}</span>
	</span>
</template>
