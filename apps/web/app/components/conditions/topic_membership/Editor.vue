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

const ctx = useConditionEditorContext();

const updateTopic = (event: Event) => {
	const topicId = (event.target as HTMLSelectElement).value;
	emit('update:modelValue', { ...props.modelValue, topicId });
	emit('save');
};

const updateOperator = (event: Event) => {
	const operator = (event.target as HTMLSelectElement).value as TopicMembershipCondition['operator'];
	emit('update:modelValue', { ...props.modelValue, operator });
	emit('save');
};
</script>

<template>
	<template v-if="variant === 'row'">
		<div>
			<label class="text-xs text-text-tertiary mb-1 block">Topic</label>
			<select :value="modelValue.topicId" class="input" @change="updateTopic">
				<option value="">Select topic...</option>
				<option v-for="topic in ctx.topics.value" :key="topic._id" :value="topic._id">
					{{ topic.name }}
				</option>
			</select>
		</div>
		<div>
			<label class="text-xs text-text-tertiary mb-1 block">Condition</label>
			<select :value="modelValue.operator" class="input" @change="updateOperator">
				<option v-for="op in TOPIC_OPERATORS" :key="op.value" :value="op.value">
					{{ op.label }}
				</option>
			</select>
		</div>
	</template>

	<template v-else>
		<div class="space-y-4">
			<div>
				<label for="topic" class="label">Topic</label>
				<select
					id="topic"
					:value="modelValue.topicId"
					class="input mt-1.5"
					@change="updateTopic"
				>
					<option value="">Select a topic...</option>
					<option v-for="topic in ctx.topics.value" :key="topic._id" :value="topic._id">
						{{ topic.name }}
					</option>
				</select>
				<p class="text-xs text-text-tertiary mt-1.5">
					Check if the contact is subscribed to this topic.
				</p>
			</div>
			<div>
				<label for="topicOperator" class="label">Condition</label>
				<select
					id="topicOperator"
					:value="modelValue.operator"
					class="input mt-1.5"
					@change="updateOperator"
				>
					<option v-for="op in TOPIC_OPERATORS" :key="op.value" :value="op.value">
						{{ op.label }}
					</option>
				</select>
			</div>
		</div>
	</template>
</template>
