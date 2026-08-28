// @vitest-environment happy-dom
/**
 * Loading / loaded / empty presentation of PostboxThreadList:
 *   - first load (loading, no rows yet) renders the layout-matching skeleton
 *   - data renders real rows (and a refresh with rows visible NEVER flashes
 *     the skeleton back)
 *   - loaded + empty renders the context-aware empty state (inbox zero /
 *     custom folder / label view)
 *
 * The component leans on Nuxt auto-imports; each composable is stubbed as a
 * global with an inert implementation so the presentational states can be
 * asserted in isolation.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, computed, nextTick, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadList from '../PostboxThreadList.vue';
import { usePostboxRowTriage } from '../../../composables/postbox/usePostboxRowTriage';
import { usePostboxOptimisticFlags } from '../../../composables/postbox/usePostboxOptimisticFlags';
import PostboxThreadRow from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';

// The generated Convex api object is only passed through to the (stubbed)
// operation composables — a self-returning proxy stands in for any path.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const prefetchSpy = vi.fn();
/** Every triage mutation the list runs; resolves like a landed useBackendOperation. */
const runSpy = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: true, result: null }));

beforeAll(() => {
	vi.stubGlobal('usePostboxPrefetch', () => ({ prefetch: prefetchSpy }));
	vi.stubGlobal('usePostboxBulkActions', () => ({
		toggle: vi.fn(),
		isSelected: () => false,
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy }));
	// The REAL flag-override composable: the list's optimistic star / mark-read
	// painting is the behaviour under test, not a stub of it.
	vi.stubGlobal('usePostboxOptimisticFlags', usePostboxOptimisticFlags);
	vi.stubGlobal('usePostboxOptimisticHide', (messages: Ref<unknown[]>) => ({
		visible: computed(() => messages.value),
		hide: vi.fn(),
		unhide: vi.fn(),
	}));
	vi.stubGlobal('usePostboxTriageUndo', () => ({
		registerMoveBack: vi.fn(),
		onWindowKeydown: vi.fn(),
	}));
	// The REAL triage composable, running against the inert useBackendOperation /
	// usePostboxTriageUndo stubs above — the list's verbs stay covered end to end
	// rather than being replaced by a mock that can drift from the real shape.
	vi.stubGlobal('usePostboxRowTriage', usePostboxRowTriage);
	vi.stubGlobal('useState', (_key: string, init?: () => unknown) => ref(init ? init() : null));
	vi.stubGlobal('POSTBOX_PENDING_COMPOSE_KEY', 'postbox:pending-compose');
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));
	vi.stubGlobal('usePostboxFolders', () => ({ folders: ref([]) }));
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	// The list resolves the sender-trust-marker flag once and passes it down.
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('resolvePostboxShortcut', () => undefined);
	// The list's empty-state copy and operation labels flow through vue-i18n now;
	// `useI18n` is a Nuxt auto-import, so it has to exist as a global.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span />' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };
const dialogStub = { template: '<span />' };
// Renderless: exposes the scoped-slot handlers the row binds, no popover.
const contextMenuStub = {
	props: ['items'],
	template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
};

function makeMessage(i: number) {
	return {
		_id: `msg-${i}` as Id<'mailMessages'>,
		fromAddress: `sender${i}@example.com`,
		fromName: `Sender ${i}`,
		subject: `Subject ${i}`,
		snippet: `Snippet ${i}`,
		receivedAt: Date.now() - i * 60_000,
		flagSeen: false,
		flagFlagged: false,
		hasAttachments: false,
	};
}

function mountList(opts: {
	loading: boolean;
	messages?: ReturnType<typeof makeMessage>[];
	folderRole?: string;
	emptyContext?: 'label';
}) {
	return mount(PostboxThreadList, {
		props: {
			mailboxId: 'mailbox-1' as never,
			messages: opts.messages ?? [],
			loading: opts.loading,
			folderRole: opts.folderRole ?? 'inbox',
			emptyContext: opts.emptyContext,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxThreadRow,
				PostboxRowCore,
				PostboxThreadListSkeleton,
				PostboxEmptyState,
				UiSkeleton,
				Icon: iconStub,
				NuxtLink: nuxtLinkStub,
				UiContextMenu: contextMenuStub,
				PostboxSnoozeDialog: dialogStub,
				PostboxLabelPickerDialog: dialogStub,
				PostboxMovePickerDialog: dialogStub,
			},
			mocks: {
				formatThreadTimestamp: () => '5m',
				resolveComponent: () => 'div',
			},
		},
	});
}

const SKELETON = '[data-testid="postbox-thread-list-skeleton"]';
const EMPTY = '[data-testid="postbox-empty-state"]';

describe('PostboxThreadList states', () => {
	it('shows the skeleton on first load (loading, no rows yet)', () => {
		const w = mountList({ loading: true });
		expect(w.find(SKELETON).exists()).toBe(true);
		expect(w.find('[role="listbox"]').exists()).toBe(false);
		expect(w.find(EMPTY).exists()).toBe(false);
	});

	it('renders real rows once data arrives', () => {
		const w = mountList({ loading: false, messages: [makeMessage(1), makeMessage(2)] });
		expect(w.find(SKELETON).exists()).toBe(false);
		expect(w.findAll('[role="option"]')).toHaveLength(2);
		expect(w.text()).toContain('Sender 1');
		expect(w.text()).toContain('Subject 2');
	});

	it('never flashes the skeleton over visible rows during a refresh', () => {
		const w = mountList({ loading: true, messages: [makeMessage(1)] });
		expect(w.find(SKELETON).exists()).toBe(false);
		expect(w.findAll('[role="option"]')).toHaveLength(1);
	});

	it('shows a quiet "All clear" for inbox zero', () => {
		const w = mountList({ loading: false, folderRole: 'inbox' });
		expect(w.find(EMPTY).exists()).toBe(true);
		expect(w.text()).toContain('All clear');
	});

	it('shows a hint + filter action for an empty custom folder', () => {
		const w = mountList({ loading: false, folderRole: '' });
		expect(w.text()).toContain('This folder is empty');
		const action = w.find(`${EMPTY} a`);
		expect(action.exists()).toBe(true);
		expect(action.attributes('href')).toBe('/dashboard/preferences/filters');
	});

	it('shows the label-specific empty state in the label view', () => {
		const w = mountList({ loading: false, folderRole: 'inbox', emptyContext: 'label' });
		expect(w.text()).toContain('No messages with this label');
		expect(w.text()).not.toContain('All clear');
	});

	it('windows a large folder: DOM row count stays bounded well under the data', () => {
		// 1000 rows is far past the ~100-row virtualization threshold, so only a
		// window (viewport + overscan) is ever mounted, not a <li> per message.
		const many = Array.from({ length: 1000 }, (_, i) => makeMessage(i));
		const w = mountList({ loading: false, messages: many });
		const rendered = w.findAll('[role="option"]').length;
		expect(rendered).toBeGreaterThan(0);
		expect(rendered).toBeLessThan(60);
		// The listbox still advertises the full scroll height so the scrollbar
		// reflects every row.
		expect(w.find('[role="listbox"]').attributes('style')).toContain('76000px');
	});

	it('renders every row for a small folder (no virtualization)', () => {
		const few = Array.from({ length: 12 }, (_, i) => makeMessage(i));
		const w = mountList({ loading: false, messages: few });
		expect(w.findAll('[role="option"]')).toHaveLength(12);
	});

	it('prefetches the adjacent rows when the open message changes', async () => {
		prefetchSpy.mockClear();
		const w = mountList({
			loading: false,
			messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
		});
		await w.setProps({ activeMessageId: 'msg-2' });
		expect(prefetchSpy).toHaveBeenCalledWith(['msg-3', 'msg-1']);
	});
});

describe('PostboxThreadList optimistic star / mark-read', () => {
	it('paints the star before the subscription confirms it', async () => {
		runSpy.mockClear();
		const w = mountList({ loading: false, messages: [makeMessage(1)] });
		expect(w.find('[aria-label="Star"]').exists()).toBe(true);

		await w.find('[aria-label="Star"]').trigger('click');
		// No new props were delivered — the row is already showing the new state.
		expect(w.find('[aria-label="Unstar"]').exists()).toBe(true);
		expect(runSpy).toHaveBeenCalledWith({ messageId: 'msg-1', starred: true });
	});

	it('paints mark-read before the subscription confirms it', async () => {
		runSpy.mockClear();
		const w = mountList({ loading: false, messages: [makeMessage(1)] });
		await w.find('[aria-label="Mark read"]').trigger('click');
		expect(w.find('[aria-label="Mark unread"]').exists()).toBe(true);
		expect(runSpy).toHaveBeenCalledWith({ messageId: 'msg-1', seen: true });
	});

	it('snaps the star back when the mutation fails', async () => {
		runSpy.mockClear();
		runSpy.mockResolvedValueOnce({ ok: false });
		const w = mountList({ loading: false, messages: [makeMessage(1)] });
		await w.find('[aria-label="Star"]').trigger('click');
		await nextTick();
		expect(w.find('[aria-label="Star"]').exists()).toBe(true);
		expect(w.find('[aria-label="Unstar"]').exists()).toBe(false);
	});

	it('hands back to the live row once the confirmed flags arrive', async () => {
		runSpy.mockClear();
		const starred = { ...makeMessage(1), flagFlagged: true };
		const w = mountList({ loading: false, messages: [makeMessage(1)] });
		await w.find('[aria-label="Star"]').trigger('click');
		await w.setProps({ messages: [starred] });
		expect(w.find('[aria-label="Unstar"]').exists()).toBe(true);

		// Unstarred elsewhere (another client): no stale override masks it.
		await w.setProps({ messages: [makeMessage(1)] });
		expect(w.find('[aria-label="Star"]').exists()).toBe(true);
	});
});

describe('PostboxThreadList hover read-ahead', () => {
	it('warms the hovered row, not just the keyboard-focused one', async () => {
		prefetchSpy.mockClear();
		const w = mountList({ loading: false, messages: [makeMessage(1), makeMessage(2)] });
		await w.findAll('li')[1]!.trigger('mouseenter');
		expect(prefetchSpy).toHaveBeenCalledWith(['msg-2']);
	});

	it('warms a row the focus ring lands on (tabbing, not just the pointer)', async () => {
		prefetchSpy.mockClear();
		const w = mountList({ loading: false, messages: [makeMessage(1), makeMessage(2)] });
		await w.findAll('li')[0]!.trigger('focusin');
		expect(prefetchSpy).toHaveBeenCalledWith(['msg-1']);
	});
});
