/**
 * The inbox list hands its read error through, so a failed list is not an
 * empty one (#721). A skipped query reports no error of its own (#1099).
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
	it('hands the failed read through', () => {
		expect(useInboxes().error.value).toBe(failure);
	});
});
