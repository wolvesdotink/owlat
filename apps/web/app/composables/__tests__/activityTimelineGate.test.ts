import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computed, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

/**
 * `useActivityTimeline` powers the admin-only "Activity" tab of the contact
 * detail page, which is not the default tab. Without a subscription gate every
 * contact page opened a `listByContact` subscription that members can never
 * surface and admins usually never open, so the composable takes an optional
 * `enabled` getter that resolves to Convex's `'skip'`.
 */
type ArgsFactory = () => unknown;

let capturedArgs: ArgsFactory | null = null;

vi.stubGlobal('useConvexQuery', (_query: unknown, args: ArgsFactory) => {
	capturedArgs = args;
	return {
		data: ref(undefined),
		error: ref(null),
		isLoading: ref(true),
		isRefetching: ref(false),
		refetch: vi.fn(),
	};
});
vi.stubGlobal('formatCompactRelativeTime', (value: number) => String(value));

const { useActivityTimeline } = await import('../useActivityTimeline');

const contactId = computed(() => 'contact_1' as Id<'contacts'>);

beforeEach(() => {
	capturedArgs = null;
});

describe('useActivityTimeline subscription gate', () => {
	it('skips while the gate is closed', () => {
		const isOpen = ref(false);
		useActivityTimeline(contactId, () => isOpen.value);
		expect(capturedArgs?.()).toBe('skip');
	});

	it('subscribes with the paging args once the gate opens', () => {
		const isOpen = ref(false);
		useActivityTimeline(contactId, () => isOpen.value);
		isOpen.value = true;
		expect(capturedArgs?.()).toEqual({ contactId: 'contact_1', limit: 20, cursor: undefined });
	});

	it('subscribes eagerly when no gate is passed (unchanged default)', () => {
		useActivityTimeline(contactId);
		expect(capturedArgs?.()).toEqual({ contactId: 'contact_1', limit: 20, cursor: undefined });
	});
});
