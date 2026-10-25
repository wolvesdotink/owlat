/**
 * The palette's Mail and Team Inbox scopes keep their last hits on screen
 * while the next query runs (keepPreviousData), report that as "searching",
 * and start every palette session from a blank slate (plan 1.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type Ref } from 'vue';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useCommandPaletteMailScope } from '../useCommandPaletteMailScope';
import { useCommandPaletteInboxScope } from '../useCommandPaletteInboxScope';

interface QueryHandle {
	args: () => unknown;
	options: { keepPreviousData?: boolean } | undefined;
	data: Ref<unknown>;
	isRefetching: Ref<boolean>;
	reset: ReturnType<typeof vi.fn>;
}

let queries: QueryHandle[] = [];
let scope: ReturnType<typeof effectScope>;

beforeEach(() => {
	queries = [];
	scope = effectScope();
	vi.stubGlobal(
		'useConvexQuery',
		(_query: unknown, args: () => unknown, options?: { keepPreviousData?: boolean }) => {
			const handle: QueryHandle = {
				args,
				options,
				data: ref<unknown>(undefined),
				isRefetching: ref(false),
				reset: vi.fn(),
			};
			queries.push(handle);
			return {
				data: handle.data,
				isLoading: ref(false),
				isRefetching: handle.isRefetching,
				error: ref(null),
				refetch: vi.fn(),
				reset: handle.reset,
			};
		}
	);
	vi.stubGlobal('useDebouncedSearch', useDebouncedSearch);
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('usePostboxActiveMailbox', () => ({
		activeMailboxId: ref('mailbox-1'),
		setActiveMailboxId: vi.fn(),
	}));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('navigateTo', vi.fn());
});

afterEach(() => {
	scope.stop();
});

function mailScope(query: Ref<string>) {
	return scope.run(() =>
		useCommandPaletteMailScope({
			query,
			caret: ref(query.value.length),
			enabled: ref(true),
			onReplace: vi.fn(),
			onRemember: vi.fn(),
		})
	)!;
}

describe('useCommandPaletteMailScope', () => {
	it('keeps the previous hits and completions while the next query runs', () => {
		mailScope(ref(''));
		const [contacts, labels, search] = queries;
		expect(contacts!.options).toEqual({ keepPreviousData: true });
		expect(search!.options).toEqual({ keepPreviousData: true });
		// The label list only re-keys on a mailbox switch; it has nothing to bridge.
		expect(labels!.options).toBeUndefined();
	});

	it('reports searching while stale hits are on screen', async () => {
		const query = ref('invoice');
		const mail = mailScope(query);
		mail.resetQuery('invoice');
		const search = queries[2]!;
		search.data.value = { messages: [] };
		await nextTick();
		expect(mail.isSearching.value).toBe(false);

		search.isRefetching.value = true;
		expect(mail.isSearching.value).toBe(true);
	});

	it('opens a hit with the searched words for find in conversation, never an operator', async () => {
		const hit = { _id: 'mm1', folderId: 'inbox', mailboxId: 'mailbox-1', subject: 'Invoice' };
		const remembered: string[] = [];
		const run = async (text: string) => {
			const query = ref(text);
			const mail = scope.run(() =>
				useCommandPaletteMailScope({
					query,
					caret: ref(text.length),
					enabled: ref(true),
					onReplace: vi.fn(),
					onRemember: (term) => remembered.push(term),
				})
			)!;
			queries[queries.length - 1]!.data.value = { messages: [hit] };
			await nextTick();
			// The palette's real sequence: pick the row, close (clearing the box and
			// resetting the scope), then run the row.
			const item = mail.hitItems.value[0]!;
			query.value = '';
			mail.resetQuery();
			await nextTick();
			item.run();
		};
		await run('from:ines@example.com "refund the duplicate" is:unread');
		await run('from:ines@example.com is:unread');
		expect(vi.mocked(navigateTo).mock.calls.map(([to]) => to)).toEqual([
			{ path: '/dashboard/postbox/inbox/mm1', query: { find: 'refund the duplicate' } },
			{ path: '/dashboard/postbox/inbox/mm1', query: {} },
		]);
		expect(remembered).toEqual([
			'from:ines@example.com "refund the duplicate" is:unread',
			'from:ines@example.com is:unread',
		]);
	});

	it('forgets the last session’s hits and completions on reset', () => {
		const mail = mailScope(ref(''));
		mail.resetQuery();
		expect(queries[0]!.reset).toHaveBeenCalledOnce();
		expect(queries[2]!.reset).toHaveBeenCalledOnce();
	});
});

describe('useCommandPaletteInboxScope', () => {
	function inboxScope(query: Ref<string>) {
		return scope.run(() =>
			useCommandPaletteInboxScope({ query, enabled: ref(true), onRemember: vi.fn() })
		)!;
	}

	it('keeps the previous thread hits while the next query runs', () => {
		inboxScope(ref(''));
		expect(queries[0]!.options).toEqual({ keepPreviousData: true });
	});

	it('reports searching while stale hits are on screen, and forgets them on reset', async () => {
		const query = ref('refund');
		const inbox = inboxScope(query);
		inbox.resetQuery('refund');
		expect(queries[0]!.reset).toHaveBeenCalledOnce();
		queries[0]!.data.value = { threads: [] };
		await nextTick();
		expect(inbox.isSearching.value).toBe(false);

		queries[0]!.isRefetching.value = true;
		expect(inbox.isSearching.value).toBe(true);
	});
});
