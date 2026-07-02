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
import { ref, computed, type Ref } from 'vue';

import PostboxThreadList from '../PostboxThreadList.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import UiSkeleton from '../../../../../../packages/ui/components/ui/Skeleton.vue';

// The generated Convex api object is only passed through to the (stubbed)
// operation composables — a self-returning proxy stands in for any path.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

beforeAll(() => {
	vi.stubGlobal('usePostboxBulkActions', () => ({
		toggle: vi.fn(),
		isSelected: () => false,
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(async () => undefined) }));
	vi.stubGlobal(
		'usePostboxOptimisticHide',
		(messages: Ref<unknown[]>) => ({
			visible: computed(() => messages.value),
			hide: vi.fn(),
			unhide: vi.fn(),
		})
	);
	vi.stubGlobal('usePostboxTriageUndo', () => ({
		registerMoveBack: vi.fn(),
		onWindowKeydown: vi.fn(),
	}));
	vi.stubGlobal('useState', (_key: string, init?: () => unknown) => ref(init ? init() : null));
	vi.stubGlobal('POSTBOX_PENDING_COMPOSE_KEY', 'postbox:pending-compose');
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));
	vi.stubGlobal('usePostboxFolders', () => ({ folders: ref([]) }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('resolvePostboxShortcut', () => undefined);
});

const iconStub = { props: ['name'], template: '<span />' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };
const dialogStub = { template: '<span />' };

function makeMessage(i: number) {
	return {
		_id: `msg-${i}`,
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
			components: {
				PostboxThreadListSkeleton,
				PostboxEmptyState,
				UiSkeleton,
				Icon: iconStub,
				NuxtLink: nuxtLinkStub,
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
		expect(action.attributes('href')).toBe('/dashboard/postbox/settings/filters');
	});

	it('shows the label-specific empty state in the label view', () => {
		const w = mountList({ loading: false, folderRole: 'inbox', emptyContext: 'label' });
		expect(w.text()).toContain('No messages with this label');
		expect(w.text()).not.toContain('All clear');
	});
});
