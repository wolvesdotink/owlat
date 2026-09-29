/**
 * `useCampaignAudience` is the one copy of a campaign's recipients state. The
 * setup wizard and the campaign edit page each used to write out the kind + id
 * refs, the derived Audience and the list subscriptions, and only the wizard
 * showed a failed topics or segments read (#818): on the edit page it looked
 * like a workspace with no topics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

interface ListHandle {
	results: Ref<Array<{ _id: string; name: string }>>;
	error: Ref<Error | null>;
	refetch: ReturnType<typeof vi.fn>;
}

let topics: ListHandle;
let segments: ListHandle;
let countArgs: () => unknown;

function list(rows: Array<{ _id: string; name: string }>): ListHandle {
	return { results: ref(rows), error: ref(null), refetch: vi.fn() };
}

beforeEach(() => {
	topics = list([{ _id: 'tp_1', name: 'Newsletter' }]);
	segments = list([{ _id: 'sg_1', name: 'Active buyers' }]);
	vi.stubGlobal('useTopicsList', () => topics);
	vi.stubGlobal('useOrganizationPaginatedQuery', () => segments);
	vi.stubGlobal('useOrganizationQuery', (_query: unknown, args: () => unknown) => {
		countArgs = args;
		return { data: ref({ total: 3, eligible: 2, completeness: 'exact' }) };
	});
});

const { useCampaignAudience } = await import('../useCampaignAudience');

const topicId = 'tp_1' as Id<'topics'>;
const segmentId = 'sg_1' as Id<'segments'>;

describe('useCampaignAudience', () => {
	it('derives one Audience only from a complete selection of the chosen kind', () => {
		const state = useCampaignAudience();
		expect(state.audience.value).toBeNull();

		state.selectedTopicId.value = topicId;
		expect(state.audience.value).toEqual({ kind: 'topic', topicId });

		// A segment id left over from an earlier pick does not leak into a topic audience.
		state.selectedSegmentId.value = segmentId;
		expect(state.audience.value).toEqual({ kind: 'topic', topicId });

		state.audienceType.value = 'segment';
		expect(state.audience.value).toEqual({ kind: 'segment', segmentId });

		state.selectedSegmentId.value = null;
		expect(state.audience.value).toBeNull();
	});

	it('counts the derived audience, and nothing until there is one', () => {
		const state = useCampaignAudience();
		expect(countArgs()).toEqual({ audience: undefined });
		state.selectedTopicId.value = topicId;
		expect(countArgs()).toEqual({ audience: { kind: 'topic', topicId } });
	});

	it('hydrates a persisted selection, and clears the other kind', () => {
		const state = useCampaignAudience();
		state.selectedTopicId.value = topicId;

		state.hydrate({ kind: 'segment', segmentId });
		expect(state.audienceType.value).toBe('segment');
		expect(state.selectedTopicId.value).toBeNull();
		expect(state.selectedSegmentId.value).toBe(segmentId);
		expect(state.selectedSegment.value?.name).toBe('Active buyers');

		state.hydrate({ kind: 'topic', topicId });
		expect(state.audience.value).toEqual({ kind: 'topic', topicId });
		expect(state.selectedTopicName.value).toBe('Newsletter');

		state.hydrate(undefined);
		expect(state.audienceType.value).toBe('topic');
		expect(state.audience.value).toBeNull();
	});

	it('reports a failed topics or segments read and retries only the failed list', () => {
		const state = useCampaignAudience();
		expect(state.audienceLoadFailed.value).toBe(false);

		segments.error.value = new Error('read failed');
		expect(state.audienceLoadFailed.value).toBe(true);
		state.retryAudienceLists();
		expect(segments.refetch).toHaveBeenCalledOnce();
		expect(topics.refetch).not.toHaveBeenCalled();

		segments.error.value = null;
		topics.error.value = new Error('read failed');
		expect(state.audienceLoadFailed.value).toBe(true);
		state.retryAudienceLists();
		expect(topics.refetch).toHaveBeenCalledOnce();
	});
});
