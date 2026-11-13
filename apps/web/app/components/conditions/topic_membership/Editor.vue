<script setup lang="ts">
import type { ConditionOfKind, ConditionVariant } from '~/composables/conditions';
import { useConditionEditorContext } from '~/composables/conditions';
import { TOPIC_OPERATORS } from '~/composables/conditions/topic_membership';

type TopicMembershipCondition = ConditionOfKind<'topic_membership'>;

const props = defineProps<{
	modelValue: TopicMembershipCondition;
	variant: ConditionVariant;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: TopicMembershipCondition];
	save: [];
}>();

const { t } = useI18n();

const ctx = useConditionEditorContext();

const updateTopic = (event: Event) => {
	const topicId = (event.target as HTMLSelectElement).value;
	emit('update:modelValue', { ...props.modelValue, topicId });
	emit('save');
};

const updateOperator = (event: Event) => {
	const operator = (event.target as HTMLSelectElement)
		.value as TopicMembershipCondition['operator'];
	emit('update:modelValue', { ...props.modelValue, operator });
	emit('save');
};

// The row variant repeats in the segment editor, so ids are per instance.
const ids = { topic: useId(), operator: useId(), help: useId() };
</script>

<template>
	<template v-if="variant === 'row'">
		<div>
			<label :for="ids.topic" class="text-xs text-text-tertiary mb-1 block">{{
				t('components.conditions.topicMembership.editor.topic')
			}}</label>
			<select :id="ids.topic" :value="modelValue.topicId" class="input" @change="updateTopic">
				<option value="">
					{{ t('components.conditions.topicMembership.editor.selectTopicShort') }}
				</option>
				<option v-for="topic in ctx.topics.value" :key="topic._id" :value="topic._id">
					{{ topic.name }}
				</option>
			</select>
		</div>
		<div>
			<label :for="ids.operator" class="text-xs text-text-tertiary mb-1 block">{{
				t('components.conditions.topicMembership.editor.condition')
			}}</label>
			<select
				:id="ids.operator"
				:value="modelValue.operator"
				class="input"
				@change="updateOperator"
			>
				<option v-for="op in TOPIC_OPERATORS" :key="op.value" :value="op.value">
					{{ t(op.label) }}
				</option>
			</select>
		</div>
	</template>

	<template v-else>
		<div class="space-y-4">
			<div>
				<label :for="ids.topic" class="label">{{
					t('components.conditions.topicMembership.editor.topic')
				}}</label>
				<select
					:id="ids.topic"
					:value="modelValue.topicId"
					class="input mt-1.5"
					:aria-describedby="ids.help"
					@change="updateTopic"
				>
					<option value="">
						{{ t('components.conditions.topicMembership.editor.selectTopic') }}
					</option>
					<option v-for="topic in ctx.topics.value" :key="topic._id" :value="topic._id">
						{{ topic.name }}
					</option>
				</select>
				<p :id="ids.help" class="text-xs text-text-tertiary mt-1.5">
					{{ t('components.conditions.topicMembership.editor.help') }}
				</p>
			</div>
			<div>
				<label :for="ids.operator" class="label">{{
					t('components.conditions.topicMembership.editor.condition')
				}}</label>
				<select
					:id="ids.operator"
					:value="modelValue.operator"
					class="input mt-1.5"
					@change="updateOperator"
				>
					<option v-for="op in TOPIC_OPERATORS" :key="op.value" :value="op.value">
						{{ t(op.label) }}
					</option>
				</select>
			</div>
		</div>
	</template>
</template>
