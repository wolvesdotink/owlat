/**
 * `useCampaignAudience` is the one copy of a campaign's recipients state. The
 * setup wizard and the campaign edit page each used to write out the kind + id
 * refs, the derived Audience and the list subscriptions, and only the wizard
 * showed a failed topics or segments read (#818): on the edit page it looked
 * like a workspace with no topics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

interface ListHandle {
	results: Ref<Array<{ _id: string; name: string }>>;
	error: Ref<Error | null>;
	refetch: ReturnType<typeof vi.fn>;
}

let topics: ListHandle;
let segments: ListHandle;
let countArgs: () => unknown;
let countData: Ref<unknown>;
let requestCount: ReturnType<typeof vi.fn>;

function list(rows: Array<{ _id: string; name: string }>): ListHandle {
	return { results: ref(rows), error: ref(null), refetch: vi.fn() };
}

beforeEach(() => {
	topics = list([{ _id: 'tp_1', name: 'Newsletter' }]);
	segments = list([{ _id: 'sg_1', name: 'Active buyers' }]);
	vi.stubGlobal('useTopicsList', () => topics);
	vi.stubGlobal('useOrganizationPaginatedQuery', () => segments);
	countData = ref({
		total: 3,
		eligible: 2,
		completeness: 'exact',
		background: { status: 'not_needed' },
	});
	vi.stubGlobal('useOrganizationQuery', (_query: unknown, args: () => unknown) => {
		countArgs = args;
		return { data: countData };
	});
	requestCount = vi.fn(async () => ({ status: 'started' }));
	vi.stubGlobal('useConvex', () => ({ mutation: requestCount }));
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

	it('asks for the exact count once when the readout stopped at one page (#916)', async () => {
		const state = useCampaignAudience();
		state.selectedTopicId.value = topicId;
		await nextTick();
		expect(requestCount).not.toHaveBeenCalled(); // an exact inline count needs no job

		countData.value = {
			total: 1_000,
			eligible: 724,
			completeness: 'read_budget_exhausted',
			background: { status: 'unavailable' },
		};
		await nextTick();
		expect(requestCount).toHaveBeenCalledOnce();
		expect(requestCount.mock.calls[0]?.[1]).toEqual({ audience: { kind: 'topic', topicId } });

		// The same reading again (a rerun) does not ask twice.
		countData.value = { ...(countData.value as object) };
		await nextTick();
		expect(requestCount).toHaveBeenCalledOnce();

		// A running job is left alone until its retry instant has passed.
		countData.value = {
			total: 2_000,
			eligible: 1_450,
			completeness: 'read_budget_exhausted',
			background: { status: 'counting', startedAt: 1, retryAfter: Date.now() + 60_000 },
		};
		await nextTick();
		expect(requestCount).toHaveBeenCalledOnce();
	});
});
