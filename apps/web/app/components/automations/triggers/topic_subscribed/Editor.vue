<script setup lang="ts">
import type { Doc } from '@owlat/api/dataModel';
import type { TopicSubscribedTriggerConfig } from '~/composables/automations/triggers';
import { ListPlusIcon } from '@coolicons/vue';

const { t } = useI18n();

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

const hintId = useId();
const errorId = useId();
</script>

<template>
	<div>
		<label for="topicId" class="label flex items-center gap-2">
			<ListPlusIcon class="w-4 h-4 text-success" />
			{{ t('components.automations.triggers.topicSubscribed.editor.topicLabel') }}
			<span class="text-error" aria-hidden="true">*</span>
		</label>
		<p :id="hintId" class="text-sm text-text-tertiary mt-1 mb-3">
			{{ t('components.automations.triggers.topicSubscribed.editor.topicHint') }}
		</p>
		<select
			id="topicId"
			aria-required="true"
			:aria-invalid="error ? true : undefined"
			:aria-describedby="error ? `${errorId} ${hintId}` : hintId"
			:value="modelValue.topicId"
			:class="['input', error ? 'input-error' : '']"
			@change="updateTopicId"
		>
			<option value="" disabled>
				{{ t('components.automations.triggers.topicSubscribed.editor.topicPlaceholder') }}
			</option>
			<option v-for="topic in topics ?? []" :key="topic._id" :value="topic._id">
				{{
					topic.contactCount === undefined
						? topic.name
						: t('components.automations.triggers.topicSubscribed.editor.topicOptionWithCount', {
								name: topic.name,
								count: topic.contactCount,
							})
				}}
			</option>
		</select>
		<p v-if="error" :id="errorId" class="mt-2 text-sm text-error">{{ error }}</p>
		<p v-else-if="!topics?.length" class="mt-2 text-sm text-text-tertiary">
			<I18nT
				keypath="components.automations.triggers.topicSubscribed.editor.noTopics"
				tag="span"
				scope="global"
			>
				<template #link>
					<NuxtLink to="/dashboard/audience/topics" class="link">
						{{ t('components.automations.triggers.topicSubscribed.editor.noTopicsLink') }}
					</NuxtLink>
				</template>
			</I18nT>
		</p>
	</div>
</template>
