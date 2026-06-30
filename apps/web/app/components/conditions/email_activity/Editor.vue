<script setup lang="ts">
import type { ConditionOfKind, ConditionVariant } from '~/composables/conditions';
import { ACTIVITY_OPTIONS, activityKey } from '~/composables/conditions/email_activity';

type EmailActivityCondition = ConditionOfKind<'email_activity'>;

const props = defineProps<{
	modelValue: EmailActivityCondition;
	variant: ConditionVariant;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EmailActivityCondition];
	save: [];
}>();

const onChange = (event: Event) => {
	const key = (event.target as HTMLSelectElement).value;
	const option = ACTIVITY_OPTIONS.find((o) => `${o.field}:${o.operator}` === key);
	if (!option) return;
	emit('update:modelValue', {
		kind: 'email_activity',
		field: option.field,
		operator: option.operator,
	});
	emit('save');
};
</script>

<template>
	<template v-if="variant === 'row'">
		<div>
			<label class="text-xs text-text-tertiary mb-1 block">Activity type</label>
			<select :value="activityKey(modelValue)" class="input" @change="onChange">
				<option value="">Select activity...</option>
				<option
					v-for="option in ACTIVITY_OPTIONS"
					:key="`${option.field}:${option.operator}`"
					:value="`${option.field}:${option.operator}`"
				>
					{{ option.label }}
				</option>
			</select>
		</div>
	</template>

	<template v-else>
		<div class="space-y-4">
			<div>
				<label for="emailActivity" class="label">Activity</label>
				<select
					id="emailActivity"
					:value="activityKey(modelValue)"
					class="input mt-1.5"
					@change="onChange"
				>
					<option
						v-for="option in ACTIVITY_OPTIONS"
						:key="`${option.field}:${option.operator}`"
						:value="`${option.field}:${option.operator}`"
					>
						{{ option.label }}
					</option>
				</select>
				<p class="text-xs text-text-tertiary mt-1.5">
					Check if the contact has performed this email activity.
				</p>
			</div>
		</div>
	</template>
</template>
