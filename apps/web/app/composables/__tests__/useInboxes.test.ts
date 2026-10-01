/**
 * The inbox list's read error only counts while the list is read: a skipped
 * query keeps its last error, which would otherwise outlive personal mail
 * being switched off (#721).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useInboxes } from '../useInboxes';

vi.mock('@owlat/api', () => ({
	api: { mail: { mailbox: { queries: { accessible: 'accessible' } } } },
}));

const postbox = ref(true);
const failure = new Error('[CONVEX Q(mail/mailbox/queries:accessible)] Server Error');

beforeEach(() => {
	postbox.value = true;
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (f: string) => f === 'postbox' && postbox.value,
	}));
	vi.stubGlobal('useConvexQuery', () => ({
		data: ref(undefined),
		isLoading: ref(false),
		error: ref(failure),
		refetch: vi.fn(),
	}));
});

describe('useInboxes', () => {
	it('reports the failed read while personal mail is on', () => {
		expect(useInboxes().error.value).toBe(failure);
	});

	it('masks the retained error once personal mail is off', () => {
		const inboxes = useInboxes();
		postbox.value = false;
		expect(inboxes.error.value).toBeNull();
	});
});
