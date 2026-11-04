<script setup lang="ts">
/**
 * The subject an open topic was written under, as the lead of the reader's
 * one meta line ("Why here? · Details"), shown only when the topic's name says
 * something else. Who named it and the way back live with the rename pencil.
 */
import { SparkleIcon } from '@coolicons/vue';
import { cleanedSubject, POSTBOX_TOPIC_HEADING } from '~/utils/postboxPeople';

const { t } = useI18n();
const topicHeading = inject(POSTBOX_TOPIC_HEADING, null);
const heading = computed(() => {
	const value = topicHeading?.value;
	return value && value.source !== 'subject' ? value : null;
});
const subject = computed(() =>
	heading.value && cleanedSubject(heading.value.subject) !== heading.value.title
		? heading.value.subject
		: null
);
</script>

<template>
	<span v-if="heading && subject" class="inline-flex min-w-0 items-center"
		><SparkleIcon
			v-if="heading.source === 'ai'"
			class="mr-1 h-3 w-3 flex-shrink-0 text-accent"
			:aria-label="t('components.postbox.people.topic.namedByOwlat')"
		/><span class="truncate">{{
			t('components.postbox.people.topic.subjectWas', { subject })
		}}</span
		>&nbsp;<span aria-hidden="true">·</span></span
	>
</template>
