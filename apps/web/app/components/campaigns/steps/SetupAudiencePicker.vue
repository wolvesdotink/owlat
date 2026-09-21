<script setup lang="ts">
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
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
/**
 * Derived from the query itself rather than hand-restated, so a new
 * `completeness` value is a COMPILE error here (the suffix mapping below has to
 * decide what it means) instead of silently falling through to "exact".
 */
type RecipientCount = FunctionReturnType<typeof api.campaigns.audienceResolution.countRecipients>;

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

const { t, locale } = useI18n();

const selectedTopicName = computed(
	() => props.topics?.find((t) => t._id === selectedTopicId.value)?.name ?? null
);
const selectedSegment = computed(
	() => props.segments?.find((s) => s._id === selectedSegmentId.value) ?? null
);

const formattedEligibleRecipients = computed(() => {
	const eligible = props.audienceCount?.eligible ?? 0;
	// A capped or budget-stopped enumeration is an "at least" reading, so it earns
	// the `+`. `suppression_truncated` is an OVER-count, not a lower bound — never
	// render it as "at least" (it cannot reach this screen today: the wizard's
	// `countRecipients` runs unbudgeted, and only a budgeted scan can truncate
	// suppression. Handled anyway so the mapping stays honest if that changes).
	const completeness = props.audienceCount?.completeness;
	const suffix =
		completeness === 'candidate_capped' || completeness === 'read_budget_exhausted' ? '+' : '';
	return `${eligible.toLocaleString(locale.value)}${suffix}`;
});

const nonEligibleRecipients = computed(() => {
	if (!props.audienceCount) return 0;
	return Math.max(0, props.audienceCount.total - props.audienceCount.eligible);
});
</script>

<template>
	<div class="card p-6">
		<div class="mb-6">
			<h2 class="text-xl font-semibold text-text-primary">{{ t('components.campaigns.steps.setupAudiencePicker.title') }}</h2>
			<p class="text-text-secondary mt-1">{{ t('components.campaigns.steps.setupAudiencePicker.subtitle') }}</p>
		</div>

		<div class="space-y-4">
			<label
				:class="[
					'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
					audienceType === 'topic'
						? 'border-text-primary bg-bg-surface'
						: 'border-border-subtle hover:border-border-default',
				]"
			>
				<input
					v-model="audienceType"
					type="radio"
					name="audienceType"
					value="topic"
					class="mt-1 w-4 h-4 text-text-primary focus:ring-brand border-border-subtle bg-bg-surface"
				/>
				<div class="flex-1">
					<div class="flex items-center gap-2">
						<Icon name="lucide:list-checks" class="w-5 h-5 text-text-tertiary" />
						<span class="font-medium text-text-primary">{{ t('components.campaigns.steps.setupAudiencePicker.topicOption') }}</span>
					</div>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('components.campaigns.steps.setupAudiencePicker.topicOptionDescription') }}
					</p>
					<div v-if="audienceType === 'topic'" class="mt-4">
						<select
							v-model="selectedTopicId"
							:class="['input w-full', error ? 'input-error' : '']"
							@click.stop
						>
							<option :value="null" disabled>{{ t('components.campaigns.steps.setupAudiencePicker.topicPlaceholder') }}</option>
							<option v-for="topic in topics" :key="topic._id" :value="topic._id">
								{{ t('components.campaigns.steps.setupAudiencePicker.topicOptionLabel', { name: topic.name, count: topic.contactCount }) }}
							</option>
						</select>
						<p v-if="error && audienceType === 'topic'" class="mt-1.5 text-sm text-error">
							{{ error }}
						</p>
						<p v-else-if="!topics?.length" class="mt-1.5 text-sm text-text-tertiary">
							{{ t('components.campaigns.steps.setupAudiencePicker.noTopics') }}
							<NuxtLink to="/dashboard/audience/topics" class="link">{{
								t('components.campaigns.steps.setupAudiencePicker.createTopic')
							}}</NuxtLink>
						</p>
					</div>
				</div>
			</label>

			<label
				:class="[
					'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
					audienceType === 'segment'
						? 'border-text-primary bg-bg-surface'
						: 'border-border-subtle hover:border-border-default',
				]"
			>
				<input
					v-model="audienceType"
					type="radio"
					name="audienceType"
					value="segment"
					class="mt-1 w-4 h-4 text-text-primary focus:ring-brand border-border-subtle bg-bg-surface"
				/>
				<div class="flex-1">
					<div class="flex items-center gap-2">
						<Icon name="lucide:filter" class="w-5 h-5 text-text-tertiary" />
						<span class="font-medium text-text-primary">{{ t('components.campaigns.steps.setupAudiencePicker.segmentOption') }}</span>
					</div>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('components.campaigns.steps.setupAudiencePicker.segmentOptionDescription') }}
					</p>
					<div v-if="audienceType === 'segment'" class="mt-4">
						<select
							v-model="selectedSegmentId"
							:class="['input w-full', error ? 'input-error' : '']"
							@click.stop
						>
							<option :value="null" disabled>{{ t('components.campaigns.steps.setupAudiencePicker.segmentPlaceholder') }}</option>
							<option v-for="segment in segments" :key="segment._id" :value="segment._id">
								{{ segment.name }}
							</option>
						</select>
						<p v-if="error && audienceType === 'segment'" class="mt-1.5 text-sm text-error">
							{{ error }}
						</p>
						<p v-else-if="!segments?.length" class="mt-1.5 text-sm text-text-tertiary">
							{{ t('components.campaigns.steps.setupAudiencePicker.noSegments') }}
							<NuxtLink to="/dashboard/audience/segments" class="link">{{
								t('components.campaigns.steps.setupAudiencePicker.createSegment')
							}}</NuxtLink>
						</p>
						<div
							v-else-if="selectedSegment"
							class="mt-3 p-3 bg-bg-elevated border border-border-subtle rounded-lg"
						>
							<p class="text-xs text-text-tertiary uppercase font-medium mb-1">
									{{ t('components.campaigns.steps.setupAudiencePicker.segmentCriteria') }}
								</p>
							<p v-if="selectedSegment.description" class="text-sm text-text-secondary">
								{{ selectedSegment.description }}
							</p>
							<p v-else class="text-sm text-text-tertiary italic">
									{{ t('components.campaigns.steps.setupAudiencePicker.noDescription') }}
								</p>
						</div>
						<div class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg">
							<p class="text-sm text-warning">
									{{ t('components.campaigns.steps.setupAudiencePicker.segmentWarning') }}
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
					<span class="text-text-secondary">{{ t('components.campaigns.steps.setupAudiencePicker.estimatedRecipients') }}</span>
				</div>
				<span
					data-testid="audience-eligible-count"
					class="text-xl font-semibold text-text-primary"
					>{{ formattedEligibleRecipients }}</span
				>
			</div>
			<p v-if="audienceType === 'topic'" class="mt-1 text-sm text-text-tertiary">
				{{ t('components.campaigns.steps.setupAudiencePicker.eligibleForTopic') }}
			</p>
			<p v-else class="mt-1 text-sm text-text-tertiary">{{ t('components.campaigns.steps.setupAudiencePicker.eligible') }}</p>

			<div
				v-if="audienceType === 'topic' && nonEligibleRecipients > 0 && audienceCount"
				class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
			>
				<p class="text-sm text-warning">
					{{
						t('components.campaigns.steps.setupAudiencePicker.nonEligible', {
							nonEligible: nonEligibleRecipients.toLocaleString(locale),
							total: audienceCount.total.toLocaleString(locale),
						})
					}}
				</p>
			</div>

			<p class="mt-2 text-sm text-text-tertiary">
				<template v-if="audienceType === 'topic' && selectedTopicName">
					{{ t('components.campaigns.steps.setupAudiencePicker.topicSummary', { topic: selectedTopicName }) }}
				</template>
				<template v-else-if="audienceType === 'segment' && selectedSegment">
					{{ t('components.campaigns.steps.setupAudiencePicker.segmentSummary', { segment: selectedSegment.name }) }}
				</template>
				<template v-else>{{ t('components.campaigns.steps.setupAudiencePicker.noSelection') }}</template>
			</p>
		</div>
	</div>
</template>
