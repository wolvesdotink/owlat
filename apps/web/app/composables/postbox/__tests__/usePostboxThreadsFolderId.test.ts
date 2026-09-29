/**
 * usePostboxThreads and usePostboxThreadSections address a system folder by id
 * when `listFolders` has it. By role, the server reads the folder document,
 * which every delivery and flag change patches, so the list's first page would
 * re-run on any mark-read in the folder. The choice is made once per folder
 * visit: a visit that starts before the folder list has loaded reads by role
 * until the next folder switch, rather than subscribing page 1 twice. The
 * virtual Snoozed view always sends the role.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computed, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxThreads } from '../usePostboxThreads';
import { usePostboxThreadSections } from '../usePostboxThreadSections';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const MAILBOX = 'mailbox-1' as Id<'mailboxes'>;
const INBOX = 'folder-inbox' as Id<'mailFolders'>;
const ARCHIVE = 'folder-archive' as Id<'mailFolders'>;

/** What `listFolders` has delivered so far; undefined while it is pending. */
const folders = ref<Array<{ _id: string; mailboxId: string; role?: string }> | undefined>();
/** Every args factory handed to useConvexQuery, in call order. */
let queryArgs: Array<() => unknown>;
let feed: { args: () => unknown; resetKey: Ref<unknown> };

beforeEach(() => {
	folders.value = undefined;
	queryArgs = [];
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		queryArgs.push(args);
		// Only the folder list is read back through `data` in these composables'
		// id resolution; the sections feed's own data is not under test here.
		return { data: queryArgs.length === 1 ? folders : ref(undefined), isLoading: ref(false) };
	});
	vi.stubGlobal(
		'usePostboxCursorFeed',
		(_query: unknown, args: () => unknown, resetKey: Ref<unknown>) => {
			feed = { args, resetKey };
			return {
				rows: computed(() => []),
				isLoading: ref(false),
				isLoadingMore: ref(false),
				isRefetching: ref(false),
				hasMore: computed(() => false),
				canLoadMore: computed(() => false),
				loadMore: vi.fn(),
			};
		}
	);
	vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
});

function loadFolders() {
	folders.value = [
		{ _id: INBOX, mailboxId: MAILBOX, role: 'inbox' },
		{ _id: ARCHIVE, mailboxId: MAILBOX, role: 'archive' },
		{ _id: 'folder-custom', mailboxId: MAILBOX },
	];
}

describe('usePostboxThreads folder id', () => {
	function mount(role = 'inbox', mailboxId: Id<'mailboxes'> = MAILBOX) {
		const folderRole = ref(role);
		usePostboxThreads({ mailboxId: ref(mailboxId), folderRole });
		return { folderRole };
	}

	it('sends the role while the folder list is still loading', () => {
		mount();
		expect(feed.args()).toEqual({ mailboxId: MAILBOX, folderRole: 'inbox', limit: 50 });
	});

	it('sends the folder id from the first read when the folder list is already loaded', () => {
		loadFolders();
		mount();
		expect(feed.args()).toEqual({ mailboxId: MAILBOX, folderId: INBOX, limit: 50 });
	});

	it('keeps a cold visit on the role when the folder list lands after it', () => {
		mount();
		const before = feed.resetKey.value;
		loadFolders();
		expect(feed.args()).toEqual({ mailboxId: MAILBOX, folderRole: 'inbox', limit: 50 });
		// No re-subscription and no dropped tail for the same folder.
		expect(feed.resetKey.value).toBe(before);
	});

	it('follows a folder switch to the new folder id', () => {
		const { folderRole } = mount();
		loadFolders();
		expect(feed.args()).toMatchObject({ folderRole: 'inbox' });
		const before = feed.resetKey.value;
		folderRole.value = 'archive';
		expect(feed.args()).toMatchObject({ folderId: ARCHIVE });
		expect(feed.resetKey.value).not.toBe(before);
	});

	it('keeps the role for the virtual Snoozed view, which has no folder', () => {
		mount('snoozed');
		loadFolders();
		expect(feed.args()).toEqual({ mailboxId: MAILBOX, folderRole: 'snoozed', limit: 50 });
	});

	it('never sends a folder id another mailbox owns', () => {
		mount('inbox', 'mailbox-2' as Id<'mailboxes'>);
		loadFolders();
		expect(feed.args()).toMatchObject({ folderRole: 'inbox' });
		expect(feed.args()).not.toHaveProperty('folderId');
	});
});

describe('usePostboxThreadSections folder id', () => {
	function mount(enabled = true) {
		usePostboxThreadSections({ mailboxId: ref(MAILBOX), enabled: ref(enabled) });
		// [0] is the folder list, [1] the sections read.
		return { folderArgs: queryArgs[0]!, sectionArgs: queryArgs[1]! };
	}

	it('reads by id when the folder list already has the inbox', () => {
		loadFolders();
		const { sectionArgs } = mount();
		expect(sectionArgs()).toMatchObject({ mailboxId: MAILBOX, folderId: INBOX });
	});

	it('stays on the role when the folder list lands after the sections opened', () => {
		const { sectionArgs } = mount();
		expect(sectionArgs()).not.toHaveProperty('folderId');
		loadFolders();
		expect(sectionArgs()).not.toHaveProperty('folderId');
	});

	it('does not subscribe to the folder list while sections are off', () => {
		const { folderArgs, sectionArgs } = mount(false);
		expect(folderArgs()).toBe('skip');
		expect(sectionArgs()).toBe('skip');
	});
});
