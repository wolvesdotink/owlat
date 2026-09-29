// @vitest-environment happy-dom
/**
 * Every inbox renderer that lists MESSAGES marks an impersonating sender.
 *
 * The flat list got the danger-only sender-trust marker (UX plan idea 51) and
 * the Sections and Bundled views did not: each hand-rolled its own row, so a
 * user who switched view mode saw the same phishing mail with no marker. All
 * three now render the shared PostboxThreadRowBody; this guard mounts each one
 * with the same spoofed-sender row and the `senderAuthBadges` flag on, and
 * walks the full view-mode list so a new renderer has to be classified here.
 *
 * The Conversations and Categories renderers list THREADS (a thread summary
 * row, no per-message authentication verdicts), so the per-message marker does
 * not apply to them; they are named below rather than silently skipped.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_VIEW_MODE_OPTIONS, type PostboxViewMode } from '~/utils/postboxViewMode';

import PostboxThreadList from '../PostboxThreadList.vue';
import PostboxThreadSectionList from '../PostboxThreadSectionList.vue';
import PostboxSectionedThreadList from '../PostboxSectionedThreadList.vue';
import PostboxThreadBundleList from '../PostboxThreadBundleList.vue';
import PostboxThreadRow from '../PostboxThreadRow.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import { usePostboxRowTriage } from '../../../composables/postbox/usePostboxRowTriage';
import { usePostboxOptimisticFlags } from '../../../composables/postbox/usePostboxOptimisticFlags';
import { usePostboxRowPickers } from '../../../composables/postbox/usePostboxRowPickers';
import { nextUnreadIndex } from '../../../utils/postboxShortcuts';
import { BASE_MESSAGE, SPOOFED_SENDER_MESSAGE } from './spoofedSenderFixture';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

let flagOn = true;

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => flagOn }));
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
	// The flat list's own wiring (triage, selection, pickers), inert or real
	// exactly as PostboxThreadListStates.test.ts runs it.
	vi.stubGlobal('usePostboxPrefetch', () => ({ prefetch: vi.fn() }));
	vi.stubGlobal('usePostboxBulkActions', () => ({ toggle: vi.fn(), isSelected: () => false }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(async () => ({ ok: true })) }));
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
	vi.stubGlobal('usePostboxRowTriage', usePostboxRowTriage);
	vi.stubGlobal('useState', (_key: string, init?: () => unknown) => ref(init ? init() : null));
	vi.stubGlobal('POSTBOX_PENDING_COMPOSE_KEY', 'postbox:pending-compose');
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));
	vi.stubGlobal('usePostboxFolders', () => ({ folders: ref([]) }));
	vi.stubGlobal('usePostboxRowPickers', usePostboxRowPickers);
	// Inert: these cases never pick a row up.
	vi.stubGlobal('usePostboxListRowDrag', () => ({ start: vi.fn() }));
	vi.stubGlobal('nextUnreadIndex', nextUnreadIndex);
	vi.stubGlobal('resolvePostboxShortcut', () => undefined);
});

const dialogStub = { template: '<span />' };

const globalOptions = {
	plugins: [createTestI18n()],
	components: {
		PostboxThreadRow,
		PostboxThreadRowBody,
		PostboxSectionedThreadList,
		PostboxRowCore,
		PostboxThreadListSkeleton,
		PostboxEmptyState,
		Icon: { props: ['name'], template: '<span />' },
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		UiContextMenu: {
			props: ['items'],
			template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
		},
		UiAvatar: { template: '<span />' },
		UiButton: { template: '<button><slot /></button>' },
		UiSkeleton: { template: '<span />' },
		PostboxSwipeTrack: { template: '<div><slot /></div>' },
		PostboxThreadRowFollowUp: { template: '<span />' },
		PostboxSnoozeDialog: dialogStub,
		PostboxLabelPickerDialog: dialogStub,
		PostboxMovePickerDialog: dialogStub,
	},
	mocks: {
		resolveComponent: () => 'a',
	},
};

/** A second, harmless row so the spoofed one is never the only thing rendered. */
const VERIFIED = {
	...BASE_MESSAGE,
	_id: 'msg-2' as Id<'mailMessages'>,
	fromAddress: 'hello@acme.com',
	fromName: 'Acme',
	spfResult: 'pass' as const,
	envelopeFromDomain: 'acme.com',
	dmarcResult: 'pass' as const,
};

/** How each MESSAGE renderer mounts; thread renderers carry the reason instead. */
const RENDERERS: Record<PostboxViewMode, (() => VueWrapper) | { listsThreads: string }> = {
	flat: () =>
		mount(PostboxThreadList, {
			props: {
				mailboxId: 'mailbox-1' as never,
				messages: [SPOOFED_SENDER_MESSAGE, VERIFIED],
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		}),
	sections: () =>
		mount(PostboxThreadSectionList, {
			props: {
				sections: [
					{
						name: null,
						key: '',
						messages: [SPOOFED_SENDER_MESSAGE, VERIFIED],
						unreadCount: 2,
						isUnreadCapped: false,
						canLoadMore: false,
					},
				],
				collapsed: {},
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		}),
	bundled: () =>
		mount(PostboxThreadBundleList, {
			props: {
				entries: [
					{ kind: 'message', message: SPOOFED_SENDER_MESSAGE },
					{ kind: 'message', message: VERIFIED },
				],
				expanded: {},
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		}),
	conversations: { listsThreads: 'PostboxThreadGroupList renders one summary row per thread' },
	categories: { listsThreads: 'PostboxThreadCategoryList renders one summary row per thread' },
};

const MARKER = '[data-testid="row-trust-marker"]';

describe('sender-trust marker across the message renderers', () => {
	it('classifies every view mode', () => {
		expect(Object.keys(RENDERERS).sort()).toEqual(
			POSTBOX_VIEW_MODE_OPTIONS.map((o) => o.value).sort()
		);
	});

	for (const [mode, renderer] of Object.entries(RENDERERS)) {
		if (typeof renderer !== 'function') continue;

		it(`${mode}: marks the spoofed sender, and only that row`, () => {
			flagOn = true;
			const w = renderer();
			const markers = w.findAll(MARKER);
			expect(markers).toHaveLength(1);
			expect(markers[0]!.text()).toBe('Failed sender check');
			expect(w.findAll('.pbx-row-danger')).toHaveLength(1);
		});

		it(`${mode}: stays silent when the flag is off`, () => {
			flagOn = false;
			const w = renderer();
			expect(w.find(MARKER).exists()).toBe(false);
			expect(w.find('.pbx-row-danger').exists()).toBe(false);
			flagOn = true;
		});
	}

	it('bundled: marks a spoofed sender inside an expanded bundle', () => {
		flagOn = true;
		const bundled = [
			{ ...SPOOFED_SENDER_MESSAGE, category: 'newsletter' as const },
			{ ...VERIFIED, category: 'newsletter' as const },
		];
		const w = mount(PostboxThreadBundleList, {
			props: {
				entries: [
					{
						kind: 'bundle',
						id: 'newsletter:msg-1',
						category: 'newsletter',
						messages: bundled,
						count: 2,
						latestFrom: 'Brightpath Finance',
						unreadCount: 2,
					},
				],
				expanded: { 'newsletter:msg-1': true },
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		});
		expect(w.findAll(MARKER)).toHaveLength(1);
		// The compact expanded row keeps the chips but drops the snippet.
		expect(w.find('.pbx-row-snippet').exists()).toBe(false);
	});

	it('sections: shows the thread state chips the server now attaches', () => {
		flagOn = true;
		const w = mount(PostboxThreadSectionList, {
			props: {
				sections: [
					{
						name: 'Team',
						key: 'Team',
						messages: [{ ...VERIFIED, mutedAt: 1, fromName: '   ' }],
						unreadCount: 1,
						isUnreadCapped: false,
						canLoadMore: false,
					},
				],
				collapsed: {},
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		});
		expect(w.find('[aria-label="Muted — new mail skips the inbox"]').exists()).toBe(true);
		// A blank display name falls back to the address, as in every renderer.
		expect(w.text()).toContain('hello@acme.com');
	});
});
