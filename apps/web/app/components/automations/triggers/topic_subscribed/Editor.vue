<script setup lang="ts">
import type { Doc } from '@owlat/api/dataModel';
import type { TopicSubscribedTriggerConfig } from '~/composables/automations/triggers';

const props = defineProps<{
	modelValue: TopicSubscribedTriggerConfig;
	topics: (Doc<'topics'> & { contactCount?: number })[] | null | undefined;
	error?: string;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: TopicSubscribedTriggerConfig];
}>();

const updateTopicId = (event: Event) => {
	const topicId = (event.target as HTMLSelectElement).value;
	emit('update:modelValue', { ...props.modelValue, topicId });
};
</script>

<template>
	<div>
		<label for="topicId" class="label flex items-center gap-2">
			<Icon name="lucide:list-plus" class="w-4 h-4 text-success" />
			Topic <span class="text-error">*</span>
		</label>
		<p class="text-sm text-text-tertiary mt-1 mb-3">
			This automation will trigger when a contact subscribes to the selected topic.
		</p>
		<select
			id="topicId"
			:value="modelValue.topicId"
			:class="['input', error ? 'input-error' : '']"
			@change="updateTopicId"
		>
			<option value="" disabled>Select a topic...</option>
			<option v-for="topic in topics ?? []" :key="topic._id" :value="topic._id">
				{{ topic.name }}<template v-if="topic.contactCount !== undefined"> ({{ topic.contactCount }} contacts)</template>
			</option>
		</select>
		<p v-if="error" class="mt-2 text-sm text-error">{{ error }}</p>
		<p v-else-if="!topics?.length" class="mt-2 text-sm text-text-tertiary">
			No topics found.
			<NuxtLink to="/dashboard/audience/topics" class="link">Create a topic</NuxtLink>
		</p>
	</div>
</template>
