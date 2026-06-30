<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

type AudienceType = 'topic' | 'segment';

interface Props {
	campaignId: Id<'campaigns'>;
	initialData?: {
		audienceType: AudienceType;
		selectedTopicId: Id<'topics'> | null;
		selectedSegmentId: Id<'segments'> | null;
	};
}

const props = withDefaults(defineProps<Props>(), {
	initialData: () => ({
		audienceType: 'topic' as AudienceType,
		selectedTopicId: null,
		selectedSegmentId: null,
	}),
});

const emit = defineEmits<{
	submit: [];
	back: [];
}>();

// Form state
const audienceType = ref<AudienceType>(props.initialData.audienceType);
const selectedTopicId = ref<Id<'topics'> | null>(
	props.initialData.selectedTopicId
);
const selectedSegmentId = ref<Id<'segments'> | null>(props.initialData.selectedSegmentId);

// One discriminated Audience value derived from the radio + dropdown state —
// the single source of truth for the count query and the submit mutation
// (ADR-0033). Null until a complete topic/segment selection exists.
const audience = computed(() => {
	if (audienceType.value === 'topic' && selectedTopicId.value) {
		return { kind: 'topic' as const, topicId: selectedTopicId.value };
	}
	if (audienceType.value === 'segment' && selectedSegmentId.value) {
		return { kind: 'segment' as const, segmentId: selectedSegmentId.value };
	}
	return null;
});

// Watch for prop changes
watch(
	() => props.initialData,
	(newData) => {
		if (newData) {
			audienceType.value = newData.audienceType;
			selectedTopicId.value = newData.selectedTopicId;
			selectedSegmentId.value = newData.selectedSegmentId;
		}
	}
);

// Error state — also the inline target for invalid-input backend failures.
const audienceError = ref<string | null>(null);

// Queries - use paginated queries for lists
const { results: topics } = useTopicsList();
const { results: segments } = usePaginatedQuery(api.segments.list, () => ({}), { initialNumItems: 100 });

const { data: audienceCount } = useOrganizationQuery(
	api.campaigns.audienceResolution.countRecipients,
	() => ({ audience: audience.value ?? undefined })
);

// Mutations — invalid-input/already-exists failures surface inline on the
// audience field via `audienceError`; other categories toast.
const { run: updateAudience } = useBackendOperation(api.campaigns.campaigns.updateAudience, {
	label: 'Update campaign audience',
	inlineTarget: audienceError,
});

// Modal state — only the loading flag is needed; validation + backend errors
// surface through `audienceError`.
const { isLoading, setLoading } = useModal();

// Computed
const selectedTopicName = computed(() => {
	if (!selectedTopicId.value || !topics.value) return null;
	const topic = topics.value.find((l: { _id: string }) => l._id === selectedTopicId.value);
	return topic?.name ?? null;
});

const selectedSegment = computed(() => {
	if (!selectedSegmentId.value || !segments.value) return null;
	return segments.value.find((s: { _id: string }) => s._id === selectedSegmentId.value) ?? null;
});

const formattedEligibleRecipients = computed(() => {
	const eligible = audienceCount.value?.eligible ?? 0;
	// The backend caps the count at COUNT_CEILING (25,000) so a huge audience
	// doesn't stream the whole table on every keystroke. Render `25,000+`.
	const suffix = audienceCount.value?.capped ? '+' : '';
	return `${eligible.toLocaleString()}${suffix}`;
});

const nonEligibleRecipients = computed(() => {
	if (!audienceCount.value) return 0;
	return Math.max(0, audienceCount.value.total - audienceCount.value.eligible);
});

// Validation
const validate = (): boolean => {
	audienceError.value = null;

	if (audienceType.value === 'topic' && !selectedTopicId.value) {
		audienceError.value = 'Please select a topic';
		return false;
	}

	if (audienceType.value === 'segment' && !selectedSegmentId.value) {
		audienceError.value = 'Please select a segment';
		return false;
	}

	return true;
};

const handleSubmit = async () => {
	if (!validate()) return;

	setLoading(true);
	try {
		const result = await updateAudience({
			campaignId: props.campaignId,
			audience: audience.value!,
		});
		if (result === undefined) return;

		emit('submit');
	} finally {
		setLoading(false);
	}
};

// Expose form data for parent — the single discriminated Audience value plus
// the display helpers the review step renders.
defineExpose({
	audience,
	audienceCount,
	selectedTopicName,
	selectedSegment,
});
</script>

<template>
	<div class="card p-6">
		<div class="mb-6">
			<h2 class="text-xl font-semibold text-text-primary">Select Audience</h2>
			<p class="text-text-secondary mt-1">Choose who will receive this campaign.</p>
		</div>

		<form @submit.prevent="handleSubmit">
			<div class="space-y-4">
				<!-- Option 1: Specific Topic -->
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

						<!-- Topic Dropdown -->
						<div v-if="audienceType === 'topic'" class="mt-4">
							<select
								v-model="selectedTopicId"
								:class="['input w-full', audienceError ? 'input-error' : '']"
								@click.stop
							>
								<option :value="null" disabled>Select a topic...</option>
								<option v-for="topic in topics" :key="topic._id" :value="topic._id">
									{{ topic.name }} ({{ topic.contactCount }} contacts)
								</option>
							</select>
							<p
								v-if="audienceError && audienceType === 'topic'"
								class="mt-1.5 text-sm text-error"
							>
								{{ audienceError }}
							</p>
							<p v-else-if="!topics?.length" class="mt-1.5 text-sm text-text-tertiary">
								No topics found.
								<NuxtLink to="/dashboard/audience/topics" class="link">
									Create a topic
								</NuxtLink>
							</p>
						</div>
					</div>
				</label>

				<!-- Option 3: Segment -->
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

						<!-- Segment Dropdown -->
						<div v-if="audienceType === 'segment'" class="mt-4">
							<select
								v-model="selectedSegmentId"
								:class="['input w-full', audienceError ? 'input-error' : '']"
								@click.stop
							>
								<option :value="null" disabled>Select a segment...</option>
								<option v-for="segment in segments" :key="segment._id" :value="segment._id">
									{{ segment.name }}
								</option>
							</select>
							<p
								v-if="audienceError && audienceType === 'segment'"
								class="mt-1.5 text-sm text-error"
							>
								{{ audienceError }}
							</p>
							<p v-else-if="!segments?.length" class="mt-1.5 text-sm text-text-tertiary">
								No segments found.
								<NuxtLink to="/dashboard/audience/segments" class="link">
									Create a segment
								</NuxtLink>
							</p>
							<!-- Segment criteria summary -->
							<div
								v-else-if="selectedSegment"
								class="mt-3 p-3 bg-bg-elevated border border-border-subtle rounded-lg"
							>
								<p class="text-xs text-text-tertiary uppercase font-medium mb-1">
									Segment Criteria
								</p>
								<p v-if="selectedSegment.description" class="text-sm text-text-secondary">
									{{ selectedSegment.description }}
								</p>
								<p v-else class="text-sm text-text-tertiary italic">No description provided</p>
							</div>

							<!-- DOI Warning for Segments -->
							<div class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg">
								<p class="text-sm text-warning">
									Segments target all matching contacts regardless of topic subscription.
									Some contacts may not have completed double opt-in. No unsubscribe link will
									be included since there is no specific topic to unsubscribe from.
								</p>
							</div>
						</div>
					</div>
				</label>
			</div>

			<!-- Estimated Recipient Count -->
			<div class="mt-6 p-4 bg-bg-surface border border-border-subtle rounded-lg">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<Icon name="lucide:users" class="w-5 h-5 text-text-tertiary" />
						<span class="text-text-secondary">Estimated recipients</span>
					</div>
					<span class="text-xl font-semibold text-text-primary">
						{{ formattedEligibleRecipients }}
					</span>
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
						{{ audienceCount.total.toLocaleString() }} contacts in this topic are not eligible
						(no email address, unsubscribed/suppressed, or double opt-in not completed) and will
						be excluded.
					</p>
				</div>

				<p class="mt-2 text-sm text-text-tertiary">
					<template v-if="audienceType === 'topic' && selectedTopicName">
						Subscribed contacts in "{{ selectedTopicName }}" will receive this campaign.
					</template>
					<template v-else-if="audienceType === 'segment' && selectedSegment">
						Contacts matching "{{ selectedSegment.name }}" criteria will receive this campaign.
					</template>
					<template v-else> Select an audience to see the estimated recipient count. </template>
				</p>
			</div>

			<!-- Actions -->
			<div class="flex items-center justify-between mt-8 pt-6 border-t border-border-subtle">
				<UiButton variant="secondary" @click="emit('back')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4" /></template>
					Back
				</UiButton>
				<UiButton
					type="submit"
					:loading="isLoading"
					:disabled="
						isLoading ||
						(audienceType === 'topic' && !selectedTopicId) ||
						(audienceType === 'segment' && !selectedSegmentId)
					"
				>
					{{ isLoading ? 'Saving...' : 'Next' }}
					<template v-if="!isLoading" #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4" /></template>
				</UiButton>
			</div>
		</form>
	</div>
</template>
