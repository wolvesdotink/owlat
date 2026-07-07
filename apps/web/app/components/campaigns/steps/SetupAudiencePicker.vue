<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

type AudienceType = 'topic' | 'segment';

interface TopicOption {
	_id: Id<'topics'>;
	name: string;
	contactCount?: number;
}
interface SegmentOption {
	_id: Id<'segments'>;
	name: string;
	description?: string | null;
}
interface RecipientCount {
	eligible: number;
	total: number;
	capped?: boolean;
}

const props = defineProps<{
	topics: readonly TopicOption[] | null;
	segments: readonly SegmentOption[] | null;
	audienceCount: RecipientCount | null;
	error: string | null;
}>();

const audienceType = defineModel<AudienceType>('audienceType', { required: true });
const selectedTopicId = defineModel<Id<'topics'> | null>('selectedTopicId', { required: true });
const selectedSegmentId = defineModel<Id<'segments'> | null>('selectedSegmentId', {
	required: true,
});

const selectedTopicName = computed(
	() => props.topics?.find((t) => t._id === selectedTopicId.value)?.name ?? null
);
const selectedSegment = computed(
	() => props.segments?.find((s) => s._id === selectedSegmentId.value) ?? null
);

const formattedEligibleRecipients = computed(() => {
	const eligible = props.audienceCount?.eligible ?? 0;
	const suffix = props.audienceCount?.capped ? '+' : '';
	return `${eligible.toLocaleString()}${suffix}`;
});

const nonEligibleRecipients = computed(() => {
	if (!props.audienceCount) return 0;
	return Math.max(0, props.audienceCount.total - props.audienceCount.eligible);
});
</script>

<template>
	<div class="card p-6">
		<div class="mb-6">
			<h2 class="text-xl font-semibold text-text-primary">Audience</h2>
			<p class="text-text-secondary mt-1">Choose who will receive this campaign.</p>
		</div>

		<div class="space-y-4">
			<label
				:class="[
					'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
					audienceType === 'topic'
						? 'border-brand bg-brand/5'
						: 'border-border-subtle hover:border-border-default',
				]"
			>
				<input
					v-model="audienceType"
					type="radio"
					name="audienceType"
					value="topic"
					class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
				/>
				<div class="flex-1">
					<div class="flex items-center gap-2">
						<Icon name="lucide:list-checks" class="w-5 h-5 text-brand" />
						<span class="font-medium text-text-primary">Specific Topic</span>
					</div>
					<p class="text-sm text-text-secondary mt-1">
						Send to contacts subscribed to a specific topic.
					</p>
					<div v-if="audienceType === 'topic'" class="mt-4">
						<select
							v-model="selectedTopicId"
							:class="['input w-full', error ? 'input-error' : '']"
							@click.stop
						>
							<option :value="null" disabled>Select a topic...</option>
							<option v-for="topic in topics" :key="topic._id" :value="topic._id">
								{{ topic.name }} ({{ topic.contactCount }} contacts)
							</option>
						</select>
						<p v-if="error && audienceType === 'topic'" class="mt-1.5 text-sm text-error">
							{{ error }}
						</p>
						<p v-else-if="!topics?.length" class="mt-1.5 text-sm text-text-tertiary">
							No topics found.
							<NuxtLink to="/dashboard/audience/topics" class="link">Create a topic</NuxtLink>
						</p>
					</div>
				</div>
			</label>

			<label
				:class="[
					'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
					audienceType === 'segment'
						? 'border-brand bg-brand/5'
						: 'border-border-subtle hover:border-border-default',
				]"
			>
				<input
					v-model="audienceType"
					type="radio"
					name="audienceType"
					value="segment"
					class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
				/>
				<div class="flex-1">
					<div class="flex items-center gap-2">
						<Icon name="lucide:filter" class="w-5 h-5 text-warning" />
						<span class="font-medium text-text-primary">Saved Segment</span>
					</div>
					<p class="text-sm text-text-secondary mt-1">
						Target contacts matching specific criteria from a saved segment.
					</p>
					<div v-if="audienceType === 'segment'" class="mt-4">
						<select
							v-model="selectedSegmentId"
							:class="['input w-full', error ? 'input-error' : '']"
							@click.stop
						>
							<option :value="null" disabled>Select a segment...</option>
							<option v-for="segment in segments" :key="segment._id" :value="segment._id">
								{{ segment.name }}
							</option>
						</select>
						<p v-if="error && audienceType === 'segment'" class="mt-1.5 text-sm text-error">
							{{ error }}
						</p>
						<p v-else-if="!segments?.length" class="mt-1.5 text-sm text-text-tertiary">
							No segments found.
							<NuxtLink to="/dashboard/audience/segments" class="link">Create a segment</NuxtLink>
						</p>
						<div
							v-else-if="selectedSegment"
							class="mt-3 p-3 bg-bg-elevated border border-border-subtle rounded-lg"
						>
							<p class="text-xs text-text-tertiary uppercase font-medium mb-1">Segment Criteria</p>
							<p v-if="selectedSegment.description" class="text-sm text-text-secondary">
								{{ selectedSegment.description }}
							</p>
							<p v-else class="text-sm text-text-tertiary italic">No description provided</p>
						</div>
						<div class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg">
							<p class="text-sm text-warning">
								Segments target all matching contacts regardless of topic subscription. Some
								contacts may not have completed double opt-in. No unsubscribe link will be included
								since there is no specific topic to unsubscribe from.
							</p>
						</div>
					</div>
				</div>
			</label>
		</div>

		<div class="mt-6 p-4 bg-bg-surface border border-border-subtle rounded-lg">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<Icon name="lucide:users" class="w-5 h-5 text-text-tertiary" />
					<span class="text-text-secondary">Estimated recipients</span>
				</div>
				<span class="text-xl font-semibold text-text-primary">{{
					formattedEligibleRecipients
				}}</span>
			</div>
			<p v-if="audienceType === 'topic'" class="mt-1 text-sm text-text-tertiary">
				Eligible recipients for this topic.
			</p>
			<p v-else class="mt-1 text-sm text-text-tertiary">Eligible recipients.</p>

			<div
				v-if="audienceType === 'topic' && nonEligibleRecipients > 0 && audienceCount"
				class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
			>
				<p class="text-sm text-warning">
					{{ nonEligibleRecipients.toLocaleString() }} of
					{{ audienceCount.total.toLocaleString() }} contacts in this topic are not eligible (no
					email address, unsubscribed/suppressed, or double opt-in not completed) and will be
					excluded.
				</p>
			</div>

			<p class="mt-2 text-sm text-text-tertiary">
				<template v-if="audienceType === 'topic' && selectedTopicName">
					Subscribed contacts in "{{ selectedTopicName }}" will receive this campaign.
				</template>
				<template v-else-if="audienceType === 'segment' && selectedSegment">
					Contacts matching "{{ selectedSegment.name }}" criteria will receive this campaign.
				</template>
				<template v-else>Select an audience to see the estimated recipient count.</template>
			</p>
		</div>
	</div>
</template>
