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

describe('useRecipientCount — a definition edit under an open page (#916)', () => {
	it('asks again when an audience drops back to unavailable after a finished count', async () => {
		const state = useCampaignAudience();
		state.audienceType.value = 'segment';
		state.selectedSegmentId.value = segmentId;
		await nextTick();
		// 1. A big live segment, no job yet.
		countData.value = {
			total: 1_000,
			eligible: 900,
			completeness: 'read_budget_exhausted',
			background: { status: 'unavailable' },
		};
		await nextTick();
		expect(requestCount).toHaveBeenCalledOnce();

		// 2. The job completes.
		const now = Date.now();
		countData.value = {
			total: 5_000,
			eligible: 4_000,
			completeness: 'exact',
			background: { status: 'complete', countedAt: now, retryAfter: now + 900_000 },
		};
		await nextTick();
		expect(requestCount).toHaveBeenCalledOnce();

		// 3. A teammate edits the segment's filters: new definition key, no job row.
		countData.value = {
			total: 1_000,
			eligible: 800,
			completeness: 'read_budget_exhausted',
			background: { status: 'unavailable' },
		};
		await nextTick();
		expect(requestCount).toHaveBeenCalledTimes(2);
		expect(requestCount.mock.calls[1]?.[1]).toEqual({ audience: { kind: 'segment', segmentId } });

		// A rerun of that same reading still asks only once.
		countData.value = { ...(countData.value as object) };
		await nextTick();
		expect(requestCount).toHaveBeenCalledTimes(2);
	});
});

describe('useRecipientCount — a stalled count is re-requested without new data (#916)', () => {
	it('re-checks at retryAfter even when the readout never changes', async () => {
		vi.useFakeTimers();
		try {
			const now = Date.now();
			const state = useCampaignAudience();
			state.selectedTopicId.value = topicId;
			await nextTick();
			// A first count whose steps stopped: no more commits, so no rerun.
			countData.value = {
				total: 0,
				eligible: 0,
				completeness: 'read_budget_exhausted',
				background: { status: 'counting', startedAt: now, retryAfter: now + 120_000 },
			};
			await nextTick();
			expect(requestCount).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(121_000);
			expect(requestCount).toHaveBeenCalledOnce();
			expect(requestCount.mock.calls[0]?.[1]).toEqual({ audience: { kind: 'topic', topicId } });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('recipient count readings for send decisions (#916)', () => {
	it('only an exact count is a size; lower bounds are "at least"', async () => {
		const { exactEligibleCount, isLowerBoundCount } = await import('../useRecipientCount');
		expect(exactEligibleCount({ eligible: 36_246, completeness: 'exact' })).toBe(36_246);
		expect(exactEligibleCount({ eligible: 724, completeness: 'read_budget_exhausted' })).toBeNull();
		expect(exactEligibleCount({ eligible: 600, completeness: 'suppression_truncated' })).toBeNull();
		expect(exactEligibleCount(undefined)).toBeNull();
		expect(isLowerBoundCount({ eligible: 724, completeness: 'read_budget_exhausted' })).toBe(true);
		expect(isLowerBoundCount({ eligible: 25_000, completeness: 'candidate_capped' })).toBe(true);
		expect(isLowerBoundCount({ eligible: 600, completeness: 'suppression_truncated' })).toBe(false);
		expect(isLowerBoundCount({ eligible: 12, completeness: 'exact' })).toBe(false);
	});
});
