<script setup lang="ts">
/**
 * The topic an automation's emails are sent for. A contact who leaves it, or
 * was never confirmed in it, gets none of this automation's emails; the other
 * steps still run. A "Subscribed to topic" automation belongs to its trigger's
 * topic until someone picks another topic or "No topic".
 *
 * The select's values: `trigger` (the field unset, so the trigger decides), a
 * topic id, or `none` (saved as an explicit no topic, which a later change of
 * the trigger to "Subscribed to topic" keeps).
 */
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';

const props = defineProps<{
	automation: {
		_id: Id<'automations'>;
		triggerType: string;
		triggerConfig?: unknown;
		topicId?: Id<'topics'> | null;
		mailTopic?: { topicId: Id<'topics'>; topic: { name: string } | null } | null;
	};
	topics: Doc<'topics'>[] | undefined;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { run: setTopic, isLoading } = useBackendOperation(api.automations.automations.setTopic, {
	label: () => t('components.automations.mailTopic.operation'),
});

const hasTopicTrigger = computed(() => props.automation.triggerType === 'topic_subscribed');

const selected = computed(() => {
	const topicId = props.automation.topicId;
	if (topicId === null) return 'none';
	if (topicId !== undefined) return topicId;
	return hasTopicTrigger.value ? 'trigger' : 'none';
});

const triggerTopicName = computed(() => {
	if (!hasTopicTrigger.value) return null;
	const triggerTopicId = (props.automation.triggerConfig as { topicId?: string } | undefined)
		?.topicId;
	return props.topics?.find((topic) => topic._id === triggerTopicId)?.name ?? null;
});

// A topic the automation points at that no longer exists: it sends nothing.
const isTopicDeleted = computed(
	() => props.automation.mailTopic != null && props.automation.mailTopic.topic === null
);

const hint = computed(() =>
	props.automation.mailTopic
		? t('components.automations.mailTopic.hintWithTopic')
		: t('components.automations.mailTopic.hintWithoutTopic')
);

const selectId = useId();
const hintId = useId();

async function onChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value;
	const topicId =
		value === 'trigger' ? ('trigger' as const) : value === 'none' ? null : (value as Id<'topics'>);
	const result = await setTopic({ automationId: props.automation._id, topicId });
	if (result.ok) showToast(t('components.automations.mailTopic.saved'));
}
</script>

<template>
	<div class="border-t border-border-subtle pt-3 mt-3" data-testid="automation-mail-topic">
		<label :for="selectId" class="text-xs font-medium text-text-tertiary uppercase tracking-wide">
			{{ t('components.automations.mailTopic.label') }}
		</label>
		<select
			:id="selectId"
			:value="selected"
			:aria-describedby="hintId"
			:disabled="isLoading"
			class="input mt-1"
			@change="onChange"
		>
			<option v-if="hasTopicTrigger" value="trigger">
				{{
					triggerTopicName
						? t('components.automations.mailTopic.sameAsTrigger', { name: triggerTopicName })
						: t('components.automations.mailTopic.sameAsTriggerUnnamed')
				}}
			</option>
			<option v-for="topic in topics ?? []" :key="topic._id" :value="topic._id">
				{{ topic.name }}
			</option>
			<option v-if="isTopicDeleted && automation.topicId" :value="automation.topicId" disabled>
				{{ t('components.automations.mailTopic.deletedOption') }}
			</option>
			<option value="none">{{ t('components.automations.mailTopic.none') }}</option>
		</select>
		<p :id="hintId" class="text-sm text-text-secondary mt-1">{{ hint }}</p>
		<p v-if="isTopicDeleted" class="text-sm text-warning mt-1">
			{{ t('components.automations.mailTopic.deleted') }}
		</p>
	</div>
</template>
