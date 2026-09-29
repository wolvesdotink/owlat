/**
 * A Workbench tab switch keeps the last loaded tab on screen, flagged stale,
 * until the new tab's watermark and digest have both landed (plan 1.6). The
 * new tab's digest must still wait for ITS OWN watermark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowReactive, type Ref } from 'vue';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';
import { useWorkbench } from '../useWorkbench';

interface QueryHandle {
	args: () => unknown;
	data: Ref<unknown>;
	isLoading: Ref<boolean>;
}

let queries: QueryHandle[] = [];
let scope: ReturnType<typeof effectScope>;

/** The live handle whose current args match, newest first. */
function handleFor(match: (args: Record<string, unknown>) => boolean): QueryHandle {
	const found = [...queries].reverse().find((q) => {
		const args = q.args();
		return args !== 'skip' && match(args as Record<string, unknown>);
	});
	if (!found) throw new Error('no query with matching args');
	return found;
}

function deliver(handle: QueryHandle, value: unknown) {
	handle.data.value = value;
	handle.isLoading.value = false;
}

const digest = (mailboxId: string, newMail: number) => ({
	mailboxId,
	newMail,
	isNewMailCapped: false,
	changed: [],
	arrived: [],
	filed: { newsletter: 0, notification: 0, receipt: 0, promotion: 0, spam: 0 },
});

beforeEach(() => {
	queries = [];
	scope = effectScope();
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: unknown) => {
		const handle: QueryHandle = {
			args: typeof args === 'function' ? (args as () => unknown) : () => args,
			data: ref<unknown>(undefined),
			isLoading: ref(true),
		};
		// A plain query blanks on new args (the default); mirror that.
		watchArgs(handle);
		queries.push(handle);
		return {
			data: handle.data,
			isLoading: handle.isLoading,
			isRefetching: ref(false),
			error: ref(null),
			refetch: vi.fn(),
			reset: vi.fn(),
		};
	});
	vi.stubGlobal('useConvexQueryMap', useConvexQueryMap);
	// useConvexQueryMap's own auto-import, missing from the shared setup file.
	vi.stubGlobal('shallowReactive', shallowReactive);
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: ref('en') }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('requireConvex', () => ({ action: vi.fn() }));
});

function watchArgs(handle: QueryHandle) {
	let key = JSON.stringify(handle.args());
	watch(
		() => JSON.stringify(handle.args()),
		(next) => {
			if (next === key) return;
			key = next;
			handle.data.value = undefined;
			handle.isLoading.value = true;
		},
		{ flush: 'sync' }
	);
}

afterEach(() => {
	scope.stop();
});

describe('useWorkbench tab switch', () => {
	it('holds the previous tab, stale, until the new one has loaded', async () => {
		const tab = ref<string | null>('mailbox-a');
		const workbench = scope.run(() => useWorkbench(tab as Ref<never>))!;

		// First load: nothing to hold yet.
		expect(workbench.isStale.value).toBe(false);
		deliver(
			handleFor((a) => a['scope'] === 'mailbox-a'),
			{ seenAt: 100, previousSeenAt: null, isFallback: false }
		);
		await nextTick();
		deliver(
			handleFor((a) => a['mailboxId'] === 'mailbox-a'),
			digest('mailbox-a', 3)
		);
		await nextTick();
		expect(workbench.model.value.newMail).toBe(3);
		expect(workbench.since.value).toBe(100);

		// Switch: A stays on screen while B's watermark loads.
		tab.value = 'mailbox-b';
		await nextTick();
		expect(workbench.isStale.value).toBe(true);
		expect(workbench.model.value.newMail).toBe(3);
		expect(workbench.since.value).toBe(100);
		// B's digest waits for B's own watermark, never A's.
		expect(() => handleFor((a) => a['mailboxId'] === 'mailbox-b')).toThrow();

		deliver(
			handleFor((a) => a['scope'] === 'mailbox-b'),
			{ seenAt: 200, previousSeenAt: null, isFallback: false }
		);
		await nextTick();
		expect(handleFor((a) => a['mailboxId'] === 'mailbox-b').args()).toMatchObject({
			since: 200,
		});
		expect(workbench.isStale.value).toBe(true);
		expect(workbench.model.value.newMail).toBe(3);

		deliver(
			handleFor((a) => a['mailboxId'] === 'mailbox-b'),
			digest('mailbox-b', 7)
		);
		await nextTick();
		expect(workbench.isStale.value).toBe(false);
		expect(workbench.model.value.newMail).toBe(7);
		expect(workbench.since.value).toBe(200);
	});
});
