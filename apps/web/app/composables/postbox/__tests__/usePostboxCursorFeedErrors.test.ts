// @vitest-environment happy-dom
/**
 * usePostboxCursorFeed — failed reads (#721).
 *
 * A Postbox list renders `firstPageError` as its error state, so only a failed
 * FIRST page may set it: a failed "Load more" must leave the rows already on
 * screen alone. `refetch` (the list's Try again) re-reads whichever page
 * failed, and only that one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';

import { usePostboxCursorFeed } from '../usePostboxCursorFeed';

interface FakePage {
	error: Ref<Error | null>;
	refetch: ReturnType<typeof vi.fn>;
}

/** The feed opens the live first page, then the cursor-keyed tail: in that order. */
function mountFeed() {
	const pages: FakePage[] = [];
	vi.stubGlobal('useConvexQuery', () => {
		const page = {
			data: ref(undefined),
			isLoading: ref(false),
			isRefetching: ref(false),
			error: ref<Error | null>(null),
			refetch: vi.fn(),
		};
		pages.push(page);
		return page;
	});
	const scope = effectScope();
	const feed = scope.run(() =>
		usePostboxCursorFeed({} as never, () => ({ limit: 2 }) as never, ref('inbox'))
	)!;
	const [first, tail] = pages as [FakePage, FakePage];
	return { feed, first, tail, stop: () => scope.stop() };
}

const failure = () => new Error('[CONVEX Q(mail/mailbox/queries:listMessages)] Server Error');

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe('usePostboxCursorFeed failed reads', () => {
	it('reports a failed first page and re-reads only that page', () => {
		const mounted = mountFeed();
		stop = mounted.stop;
		mounted.first.error.value = failure();

		expect(mounted.feed.firstPageError.value).toBe(mounted.first.error.value);
		mounted.feed.refetch();
		expect(mounted.first.refetch).toHaveBeenCalledTimes(1);
		expect(mounted.tail.refetch).not.toHaveBeenCalled();
	});

	it('keeps a failed Load more out of the list error, but retries it', () => {
		const mounted = mountFeed();
		stop = mounted.stop;
		mounted.tail.error.value = failure();

		expect(mounted.feed.firstPageError.value).toBeNull();
		expect(mounted.feed.error.value).toBe(mounted.tail.error.value);
		mounted.feed.refetch();
		expect(mounted.tail.refetch).toHaveBeenCalledTimes(1);
		expect(mounted.first.refetch).not.toHaveBeenCalled();
	});
});
