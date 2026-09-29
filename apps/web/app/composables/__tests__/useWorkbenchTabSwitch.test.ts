/**
 * A Workbench tab switch keeps the last loaded tab on screen, flagged stale,
 * until the new tab's digest has landed (plan 1.6). The watermark comes from
 * one unscoped state read shared with the inbox choice, and the digest reads
 * its own watermark on the server, so a tab costs one round trip after the
 * tab is known, not two (plan 2.10).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowReactive, type Ref } from 'vue';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';
import { useWorkbench, useWorkbenchInboxChoice } from '../useWorkbench';

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

/** The unscoped state read: hide list plus every tab's watermark. */
const state = (marks: Array<{ scope: string; seenAt: number }>, unmarked = 50) => ({
	seenAt: unmarked,
	previousSeenAt: null,
	isFallback: false,
	hiddenMailboxIds: [],
	watermarks: {
		unmarked: { seenAt: unmarked, previousSeenAt: null, isFallback: false },
		marks: marks.map((m) => ({ ...m, previousSeenAt: null, isFallback: false })),
	},
});

const isStateRead = (a: unknown) =>
	typeof a === 'object' && a !== null && !('mailboxId' in a) && !('view' in a);

describe('useWorkbench tab switch', () => {
	it('holds the previous tab, stale, until the new one has loaded', async () => {
		const tab = ref<string | null>('mailbox-a');
		const workbench = scope.run(() => useWorkbench(tab as Ref<never>))!;

		// First load: nothing to hold yet. The digest does not wait for the watermark.
		expect(workbench.isStale.value).toBe(false);
		expect(handleFor((a) => a['mailboxId'] === 'mailbox-a').args()).toEqual({
			mailboxId: 'mailbox-a',
			locale: 'en',
		});
		deliver(
			handleFor(isStateRead),
			state([
				{ scope: 'mailbox-a', seenAt: 100 },
				{ scope: 'mailbox-b', seenAt: 200 },
			])
		);
		await nextTick();
		deliver(
			handleFor((a) => a['mailboxId'] === 'mailbox-a'),
			digest('mailbox-a', 3)
		);
		await nextTick();
		expect(workbench.model.value.newMail).toBe(3);
		expect(workbench.since.value).toBe(100);

		// Switch: B's digest subscribes at once; A stays on screen until it lands.
		tab.value = 'mailbox-b';
		await nextTick();
		expect(workbench.isStale.value).toBe(true);
		expect(workbench.model.value.newMail).toBe(3);
		expect(workbench.since.value).toBe(100);
		expect(handleFor((a) => a['mailboxId'] === 'mailbox-b').args()).toEqual({
			mailboxId: 'mailbox-b',
			locale: 'en',
		});

		deliver(
			handleFor((a) => a['mailboxId'] === 'mailbox-b'),
			digest('mailbox-b', 7)
		);
		await nextTick();
		expect(workbench.isStale.value).toBe(false);
		expect(workbench.model.value.newMail).toBe(7);
		expect(workbench.since.value).toBe(200);
	});

	it('uses the unmarked watermark for a tab without a mark of its own', async () => {
		const tab = ref<string | null>('mailbox-c');
		const workbench = scope.run(() => useWorkbench(tab as Ref<never>))!;
		deliver(handleFor(isStateRead), state([{ scope: 'mailbox-a', seenAt: 100 }], 70));
		deliver(
			handleFor((a) => a['mailboxId'] === 'mailbox-c'),
			digest('mailbox-c', 1)
		);
		await nextTick();
		expect(workbench.since.value).toBe(70);
		expect(workbench.previousSeenAt.value).toBeNull();
	});
});

describe('useWorkbench queries', () => {
	it('skips the digest until the tab is known', async () => {
		const tab = ref<string | null>(null);
		scope.run(() => useWorkbench(tab as Ref<never>));
		expect(() => handleFor((a) => 'mailboxId' in a)).toThrow();

		tab.value = 'mailbox-a';
		await nextTick();
		expect(handleFor((a) => a['mailboxId'] === 'mailbox-a')).toBeDefined();
	});

	it('reads the state once, unscoped, for the tab and the inbox choice alike', () => {
		const tab = ref<string | null>('mailbox-a');
		scope.run(() => {
			useWorkbenchInboxChoice();
			useWorkbench(tab as Ref<never>);
		});
		const stateArgs = queries.map((q) => q.args()).filter(isStateRead);
		// Identical args, so the subscription registry shares one subscription;
		// no per-mount `now` and no scope that would key a second one.
		expect(stateArgs).toEqual([{}, {}]);
	});
});
