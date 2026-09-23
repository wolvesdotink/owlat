<script setup lang="ts">
/**
 * ONE recipients control (#785): "Send to [everyone subscribed to Newsletter ▾]".
 * Topics and segments sit in the same select, grouped and each with its count,
 * instead of two radio cards a user had to understand before picking. The
 * parent still receives the three models it always had (kind + either id), so
 * the count query and the submit payload are unchanged.
 */
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { decodeAudienceValue, encodeAudienceValue } from '~/utils/campaignSetupReadiness';

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
	/** Refreshed by the segment-count cron; absent until the first refresh. */
	cachedCount?: number | null;
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

const prefix = 'components.campaigns.steps.setupAudiencePicker';

/** The one select's value, derived from (and written back into) the models. */
const selectedValue = computed<string>({
	get() {
		if (audienceType.value === 'topic' && selectedTopicId.value) {
			return encodeAudienceValue('topic', selectedTopicId.value);
		}
		if (audienceType.value === 'segment' && selectedSegmentId.value) {
			return encodeAudienceValue('segment', selectedSegmentId.value);
		}
		return '';
	},
	set(value) {
		const decoded = decodeAudienceValue(value);
		if (!decoded) return;
		audienceType.value = decoded.kind;
		selectedTopicId.value = decoded.kind === 'topic' ? (decoded.id as Id<'topics'>) : null;
		selectedSegmentId.value = decoded.kind === 'segment' ? (decoded.id as Id<'segments'>) : null;
	},
});

function formatCount(count: number | null | undefined): string | null {
	return typeof count === 'number' ? count.toLocaleString(locale.value) : null;
}

const topicOptions = computed(() =>
	(props.topics ?? []).map((topic) => {
		const count = formatCount(topic.contactCount);
		return {
			value: encodeAudienceValue('topic', topic._id),
			label:
				count === null
					? t(`${prefix}.topicOptionNoCount`, { name: topic.name })
					: t(`${prefix}.topicOption`, { name: topic.name, count }),
		};
	})
);

const segmentOptions = computed(() =>
	(props.segments ?? []).map((segment) => {
		const count = formatCount(segment.cachedCount);
		return {
			value: encodeAudienceValue('segment', segment._id),
			label:
				count === null
					? t(`${prefix}.segmentOptionNoCount`, { name: segment.name })
					: t(`${prefix}.segmentOption`, { name: segment.name, count }),
		};
	})
);

const hasAnyOption = computed(
	() => topicOptions.value.length > 0 || segmentOptions.value.length > 0
);

const selectedSegment = computed(() =>
	audienceType.value === 'segment'
		? (props.segments?.find((s) => s._id === selectedSegmentId.value) ?? null)
		: null
);

const hasSelection = computed(() => selectedValue.value !== '');

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
			<h2 class="text-xl font-semibold text-text-primary">{{ t(`${prefix}.title`) }}</h2>
			<p class="text-text-secondary mt-1">{{ t(`${prefix}.subtitle`) }}</p>
		</div>

		<label for="audiencePicker" class="label flex items-center gap-2">
			<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
			{{ t(`${prefix}.sendTo`) }}
			<span class="text-error">*</span>
		</label>
		<select
			id="audiencePicker"
			v-model="selectedValue"
			data-testid="audience-picker"
			:class="['input w-full mt-1.5', error ? 'input-error' : '']"
			:aria-invalid="error ? 'true' : undefined"
		>
			<option value="" disabled>{{ t(`${prefix}.placeholder`) }}</option>
			<optgroup v-if="topicOptions.length" :label="t(`${prefix}.topicsGroup`)">
				<option v-for="option in topicOptions" :key="option.value" :value="option.value">
					{{ option.label }}
				</option>
			</optgroup>
			<optgroup v-if="segmentOptions.length" :label="t(`${prefix}.segmentsGroup`)">
				<option v-for="option in segmentOptions" :key="option.value" :value="option.value">
					{{ option.label }}
				</option>
			</optgroup>
		</select>
		<p v-if="error" class="mt-1.5 text-sm text-error">{{ error }}</p>
		<p
			v-else-if="topics && segments && !hasAnyOption"
			class="mt-1.5 text-sm text-text-tertiary"
			data-testid="audience-empty"
		>
			{{ t(`${prefix}.empty`) }}
			<NuxtLink to="/dashboard/audience/topics" class="link">{{
				t(`${prefix}.createTopic`)
			}}</NuxtLink>
			·
			<NuxtLink to="/dashboard/audience/segments" class="link">{{
				t(`${prefix}.createSegment`)
			}}</NuxtLink>
		</p>
		<p
			v-else-if="audienceType === 'topic' && hasSelection"
			class="mt-1.5 text-sm text-text-tertiary"
		>
			{{ t(`${prefix}.topicHelp`) }}
		</p>

		<div v-if="selectedSegment" class="mt-3 space-y-3">
			<p v-if="selectedSegment.description" class="text-sm text-text-secondary">
				{{ selectedSegment.description }}
			</p>
			<div class="p-3 bg-warning/10 border border-warning/20 rounded-lg">
				<p class="text-sm text-warning">{{ t(`${prefix}.segmentWarning`) }}</p>
			</div>
		</div>

		<div class="mt-6 p-4 bg-bg-surface border border-border-subtle rounded-lg">
			<div class="flex items-center justify-between">
				<span class="text-text-secondary">{{ t(`${prefix}.estimatedRecipients`) }}</span>
				<span
					data-testid="audience-eligible-count"
					class="text-xl font-semibold text-text-primary tabular-nums"
					>{{ formattedEligibleRecipients }}</span
				>
			</div>
			<p v-if="!hasSelection" class="mt-1 text-sm text-text-tertiary">
				{{ t(`${prefix}.noSelection`) }}
			</p>

			<div
				v-if="audienceType === 'topic' && nonEligibleRecipients > 0 && audienceCount"
				class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
			>
				<p class="text-sm text-warning">
					{{
						t(`${prefix}.nonEligible`, {
							nonEligible: nonEligibleRecipients.toLocaleString(locale),
							total: audienceCount.total.toLocaleString(locale),
						})
					}}
				</p>
			</div>
		</div>
	</div>
</template>
