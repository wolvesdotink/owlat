import { computed, ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useRecipientCount } from './useRecipientCount';

export type CampaignAudienceType = 'topic' | 'segment';

/** The selection a campaign stores (ADR-0033); the send-time snapshot is ignored. */
export type CampaignAudienceSelection =
	| { kind: 'topic'; topicId: Id<'topics'> }
	| { kind: 'segment'; segmentId: Id<'segments'> };

/**
 * A campaign's recipients: the state behind `CampaignsStepsSetupAudiencePicker`,
 * shared by the setup wizard (`SetupStep.vue`) and the campaign edit page
 * (`useCampaignForm`).
 *
 * The picker v-models the three refs (kind + either id). Everything else reads
 * the one derived `audience` value, which is null until a complete selection
 * exists. The topics and segments subscriptions come with their errors, so a
 * failed read shows as a failure with a retry, never as "no topics" (#818).
 */
export function useCampaignAudience() {
	const audienceType = ref<CampaignAudienceType>('topic');
	const selectedTopicId = ref<Id<'topics'> | null>(null);
	const selectedSegmentId = ref<Id<'segments'> | null>(null);

	const audience = computed<CampaignAudienceSelection | null>(() => {
		if (audienceType.value === 'topic' && selectedTopicId.value) {
			return { kind: 'topic', topicId: selectedTopicId.value };
		}
		if (audienceType.value === 'segment' && selectedSegmentId.value) {
			return { kind: 'segment', segmentId: selectedSegmentId.value };
		}
		return null;
	});

	/** Load a persisted selection into the refs; none resets to an empty topic pick. */
	function hydrate(saved: CampaignAudienceSelection | null | undefined) {
		audienceType.value = saved?.kind ?? 'topic';
		selectedTopicId.value = saved?.kind === 'topic' ? saved.topicId : null;
		selectedSegmentId.value = saved?.kind === 'segment' ? saved.segmentId : null;
	}

	const { results: topics, error: topicsError, refetch: refetchTopics } = useTopicsList();
	const {
		results: segments,
		error: segmentsError,
		refetch: refetchSegments,
	} = useOrganizationPaginatedQuery(api.segments.list, undefined, { initialNumItems: 100 });

	const audienceLoadFailed = computed(() => !!topicsError.value || !!segmentsError.value);
	function retryAudienceLists() {
		if (topicsError.value) refetchTopics();
		if (segmentsError.value) refetchSegments();
	}

	const audienceCount = useRecipientCount(() => audience.value);

	const selectedTopicName = computed(() => {
		if (!selectedTopicId.value || !topics.value) return null;
		return topics.value.find((topic) => topic._id === selectedTopicId.value)?.name ?? null;
	});

	const selectedSegment = computed(() => {
		if (!selectedSegmentId.value || !segments.value) return null;
		return segments.value.find((segment) => segment._id === selectedSegmentId.value) ?? null;
	});

	return {
		audienceType,
		selectedTopicId,
		selectedSegmentId,
		audience,
		hydrate,
		topics,
		segments,
		audienceLoadFailed,
		retryAudienceLists,
		audienceCount,
		selectedTopicName,
		selectedSegment,
	};
}
