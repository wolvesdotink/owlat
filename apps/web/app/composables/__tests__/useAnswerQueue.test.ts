/**
 * The Answer queue's list waits for the member role: the team drafts and the
 * chat mentions are gated on it, so a queue that started before the role
 * resolved would begin on the mail rows alone and take a team draft in later,
 * at the end instead of at its rank ("1 of 3", then "1 of 4" on a reopen).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useAnswerQueue } from '../useAnswerQueue';

vi.mock('@owlat/api', () => ({
	api: {
		mail: { needsReply: { listQueue: 'listQueue' } },
		inbox: { queries: { getReviewQueue: 'getReviewQueue' } },
		chat: { mentions: { listMyUnreadMentions: 'listMyUnreadMentions' } },
	},
}));

const role = ref<string | null>(null);
const roleLoading = ref(true);
const review = ref<unknown[] | undefined>(undefined);

beforeEach(() => {
	role.value = null;
	roleLoading.value = true;
	review.value = undefined;
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (f: string) => f === 'inbox' }));
	vi.stubGlobal('usePermissions', () => ({
		isAdmin: computed(() => role.value === 'admin'),
		isRoleLoading: roleLoading,
	}));
	vi.stubGlobal('useInboxes', () => ({
		ids: ref(['mbx_1']),
		byId: ref(new Map()),
		isLoading: ref(false),
	}));
	vi.stubGlobal(
		'useConvexQueryMap',
		() =>
			new Map([
				[
					'mbx_1',
					{
						data: ref({ items: [{ threadId: 'thr_a', receivedAt: 1, urgency: 'normal' }] }),
						isLoading: ref(false),
					},
				],
			])
	);
	vi.stubGlobal('useConvexQuery', (fn: string, args: () => unknown) => {
		if (fn === 'getReviewQueue') {
			return {
				data: computed(() => (args() === 'skip' ? undefined : review.value)),
				isLoading: computed(() => args() !== 'skip' && review.value === undefined),
			};
		}
		return { data: ref(undefined), isLoading: ref(false) };
	});
});

describe('useAnswerQueue', () => {
	it('is still loading while the role resolves, so the queue starts with the team draft in place', () => {
		const queue = useAnswerQueue();
		// The mail rows are in, but the role is not: not whole yet.
		expect(queue.isLoading.value).toBe(true);

		roleLoading.value = false;
		role.value = 'admin';
		// Now the team query runs.
		expect(queue.isLoading.value).toBe(true);
		review.value = [
			{
				message: { _id: 'in_1', receivedAt: 2, draftResponse: 'Draft', from: 'x@example.org' },
				thread: { _id: 'ct_1' },
			},
		];
		expect(queue.isLoading.value).toBe(false);
		expect(queue.items.value.map((i) => i.id).sort()).toEqual(['mail:thr_a', 'team:in_1']);
	});

	it('does not wait on the role when the queue is not in use', () => {
		const queue = useAnswerQueue({ enabled: () => false });
		expect(queue.isLoading.value).toBe(false);
	});

	it('reports a failed source and re-reads only that one (#721)', () => {
		const inboxRefetch = vi.fn();
		const mailRefetch = vi.fn();
		const failure = new Error('[CONVEX Q(mail/needsReply:listQueue)] Server Error');
		vi.stubGlobal('useInboxes', () => ({
			ids: ref(['mbx_1']),
			byId: ref(new Map()),
			isLoading: ref(false),
			error: ref(null),
			refetch: inboxRefetch,
		}));
		vi.stubGlobal(
			'useConvexQueryMap',
			() =>
				new Map([
					[
						'mbx_1',
						{
							data: ref(undefined),
							isLoading: ref(false),
							error: ref(failure),
							refetch: mailRefetch,
						},
					],
				])
		);
		vi.stubGlobal('useConvexQuery', () => ({
			data: ref(undefined),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}));

		const queue = useAnswerQueue();
		expect(queue.items.value).toEqual([]);
		expect(queue.error.value).toBe(failure);
		queue.refetch();
		expect(mailRefetch).toHaveBeenCalledTimes(1);
		expect(inboxRefetch).not.toHaveBeenCalled();
	});

	it("drops a skipped source's retained error once the role or feature turns it off", () => {
		const failure = new Error('[CONVEX Q(inbox/queries:getReviewQueue)] Server Error');
		const reviewRefetch = vi.fn();
		const inboxOn = ref(true);
		vi.stubGlobal('useFeatureFlag', () => ({
			isEnabled: (f: string) => f === 'inbox' && inboxOn.value,
		}));
		vi.stubGlobal('useInboxes', () => ({
			ids: ref([]),
			byId: ref(new Map()),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}));
		vi.stubGlobal('useConvexQueryMap', () => new Map());
		// A subscription switched to 'skip' keeps its last error.
		vi.stubGlobal('useConvexQuery', (fn: string) => ({
			data: ref(undefined),
			isLoading: ref(false),
			error: ref(fn === 'getReviewQueue' ? failure : null),
			refetch: fn === 'getReviewQueue' ? reviewRefetch : vi.fn(),
		}));
		roleLoading.value = false;
		role.value = 'admin';

		const queue = useAnswerQueue();
		expect(queue.error.value).toBe(failure);

		inboxOn.value = false;
		expect(queue.error.value).toBeNull();
		queue.refetch();
		expect(reviewRefetch).not.toHaveBeenCalled();

		inboxOn.value = true;
		role.value = 'member';
		expect(queue.error.value).toBeNull();
	});
});
