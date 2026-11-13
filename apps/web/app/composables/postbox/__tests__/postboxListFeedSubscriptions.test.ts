/**
 * Which list queries the Postbox layout's feeds subscribe, per inbox mode and
 * renderer. Wires the flat feed, the inbox modes and the list sources the way
 * PostboxLayout does and counts the wire subscriptions a fake Convex client
 * receives, per query name. A feed for a list that is not on screen costs a
 * re-run and a re-sent page on every delivery and mark-read in the mailbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, reactive, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { useConvexQuery } from '../../useConvexQuery';
import { useGrowableLimit } from '../useGrowableLimit';
import { usePostboxCursorFeed } from '../usePostboxCursorFeed';
import { usePostboxThreadGroups } from '../usePostboxThreadGroups';
import { usePostboxThreadCategories } from '../usePostboxThreadCategories';
import { usePostboxThreadSections } from '../usePostboxThreadSections';
import { usePostboxThreads } from '../usePostboxThreads';
import { usePostboxInboxModes } from '../usePostboxInboxModes';
import { usePostboxListSources } from '../usePostboxListSources';
import { resetSharedConvexSubscriptions } from '~/lib/sharedConvexSubscriptions';
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';

const FLAT = 'mail/mailbox/queries:listMessages';
const THREADS = 'mail/mailbox/queries:listThreads';
const SECTIONS = 'mail/sections:listSections';

vi.mock('../usePostboxRoleFolderId', () => ({
	usePostboxRoleFolderId: () => ref(null),
}));

let opened: string[];

function fakeClient() {
	return {
		onUpdate: (query: unknown) => {
			opened.push(getFunctionName(query as never));
			return Object.assign(() => {}, { getCurrentValue: () => undefined });
		},
	};
}

const subscriptions = (name: string) => opened.filter((n) => n === name).length;

let modes: ReturnType<typeof usePostboxInboxModes>;

function mountFeeds(saved: { inboxMode: PostboxInboxMode; viewMode: PostboxViewMode }) {
	const savedInboxMode: Ref<PostboxInboxMode> = ref(saved.inboxMode);
	const Host = defineComponent({
		setup() {
			const mailboxId = ref('mb1' as never);
			const folderRole = ref('inbox');
			const folderId = ref(undefined);
			const feed = usePostboxThreads({ mailboxId, folderRole, folderId });
			modes = usePostboxInboxModes({
				folderRole,
				folderId,
				activeMessageId: ref(null),
				railOpen: ref(false),
				savedViewMode: ref(saved.viewMode),
				setViewMode: async () => true,
				savedInboxMode,
				setInboxMode: async (mode) => {
					savedInboxMode.value = mode;
					return true;
				},
			});
			usePostboxListSources({
				mailboxId,
				folderRole,
				folderId,
				renderer: modes.activeListRenderer,
				listMessages: feed.messages,
				flatRead: feed,
				showingCached: ref(false),
			});
			return () => null;
		},
	});
	mount(Host);
}

beforeEach(() => {
	opened = [];
	const client = fakeClient();
	const route = reactive({ query: {} as Record<string, unknown> });
	vi.stubGlobal('useConvex', () => client);
	vi.stubGlobal('useConvexQuery', useConvexQuery);
	vi.stubGlobal('useGrowableLimit', useGrowableLimit);
	vi.stubGlobal('usePostboxCursorFeed', usePostboxCursorFeed);
	vi.stubGlobal('usePostboxThreadGroups', usePostboxThreadGroups);
	vi.stubGlobal('usePostboxThreadCategories', usePostboxThreadCategories);
	vi.stubGlobal('usePostboxThreadSections', usePostboxThreadSections);
	vi.stubGlobal('usePostboxThreadBundles', () => ({}));
	vi.stubGlobal('usePostboxViewMarkRead', () => ({}));
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
	vi.stubGlobal('useCommandPalette', () => ({ open: vi.fn() }));
	vi.stubGlobal('useRoute', () => route);
	vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }));
});

afterEach(() => {
	resetSharedConvexSubscriptions();
});

describe('Postbox list feed subscriptions', () => {
	it.each([
		['conversations', THREADS],
		['categories', THREADS],
		['sections', SECTIONS],
	] as const)(
		'the Priority view opens no %s feed, only the flat feed it renders from',
		async (viewMode, grouped) => {
			mountFeeds({ inboxMode: 'today', viewMode });
			await nextTick();

			expect(modes.todayActive.value).toBe(true);
			expect(subscriptions(FLAT)).toBe(1);
			expect(subscriptions(grouped)).toBe(0);
		}
	);

	it('switching from Priority to All mail opens the grouped feed once', async () => {
		mountFeeds({ inboxMode: 'today', viewMode: 'conversations' });
		await nextTick();

		modes.switchInboxMode('browse');
		await nextTick();

		expect(subscriptions(THREADS)).toBe(1);
		expect(subscriptions(FLAT)).toBe(1);
	});

	// The flat feed stays under the grouped renderers: its rows are the reader's
	// first source for the open message and the offline cache's live rows.
	it('All mail with Conversations keeps the flat feed beside its own', async () => {
		mountFeeds({ inboxMode: 'browse', viewMode: 'conversations' });
		await nextTick();

		expect(subscriptions(THREADS)).toBe(1);
		expect(subscriptions(FLAT)).toBe(1);
	});
});
