/**
 * PostboxThreadList — a sweep end to end: a press on a row's checkbox or hover
 * Archive button, a drag across the rendered rows, the release. The list wires
 * the real sweep, the real triage verbs and the real optimistic hide; only the
 * Convex operation and the selection store are stand-ins, so what is asserted
 * is the one mutation (or the one selection write) a sweep produces.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadList from '../PostboxThreadList.vue';
import PostboxThreadRow from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import { usePostboxRowTriage } from '../../../composables/postbox/usePostboxRowTriage';
import { usePostboxOptimisticFlags } from '../../../composables/postbox/usePostboxOptimisticFlags';
import { usePostboxOptimisticHide } from '../../../composables/postbox/usePostboxOptimisticHide';
import { usePostboxRowPickers } from '../../../composables/postbox/usePostboxRowPickers';
import {
	usePostboxListRowDrag,
	usePostboxMessageDrag,
} from '../../../composables/postbox/usePostboxMessageDrag';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const ROW_PX = 60;
const runSpy = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: true, result: null }));
const selectedIds = ref<string[]>([]);
const setRange = vi.fn();

beforeAll(() => {
	vi.stubGlobal('usePostboxPrefetch', () => ({ prefetch: vi.fn() }));
	vi.stubGlobal('usePostboxBulkActions', () => ({
		toggle: vi.fn(),
		extendTo: vi.fn(),
		setRange,
		ids: selectedIds,
		isSelected: (id: string) => selectedIds.value.includes(id),
		clear: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy }));
	vi.stubGlobal('usePostboxOptimisticFlags', usePostboxOptimisticFlags);
	vi.stubGlobal('usePostboxOptimisticHide', usePostboxOptimisticHide);
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack: vi.fn(), undo: vi.fn() }));
	vi.stubGlobal('usePostboxRowTriage', usePostboxRowTriage);
	vi.stubGlobal('useState', (_key: string, init?: () => unknown) => ref(init ? init() : null));
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));
	vi.stubGlobal('usePostboxFolders', () => ({ folders: ref([]) }));
	vi.stubGlobal('usePostboxRowPickers', usePostboxRowPickers);
	vi.stubGlobal('usePostboxListRowDrag', usePostboxListRowDrag);
	vi.stubGlobal('usePostboxMessageDrag', usePostboxMessageDrag);
	vi.stubGlobal('useRoute', () => ({ params: { folder: 'inbox' } }));
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
	// The delete guard reads the route a failed delete returns from.
	vi.stubGlobal('useRouter', () => ({ currentRoute: ref({ path: '/dashboard/postbox/inbox' }) }));
	vi.stubGlobal('resolvePostboxShortcut', () => undefined);
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

beforeEach(() => {
	runSpy.mockClear();
	setRange.mockClear();
	selectedIds.value = [];
});

function makeMessage(i: number, mailboxId = 'mailbox-1') {
	return {
		_id: `msg-${i}` as Id<'mailMessages'>,
		mailboxId,
		fromAddress: `sender${i}@example.com`,
		fromName: `Sender ${i}`,
		subject: `Subject ${i}`,
		snippet: `Snippet ${i}`,
		receivedAt: 1_700_000_000_000 - i * 60_000,
		flagSeen: true,
		flagFlagged: false,
		hasAttachments: false,
	};
}

function mountList(
	messages: ReturnType<typeof makeMessage>[],
	folderRole: Ref<string> = ref('inbox')
) {
	const w = mount(PostboxThreadList, {
		props: {
			mailboxId: 'mailbox-1' as never,
			messages,
			loading: false,
			folderRole: folderRole.value,
		},
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxThreadRow,
				PostboxRowCore,
				PostboxThreadRowBody,
				PostboxThreadListSkeleton,
				PostboxEmptyState,
				Icon: { props: ['name'], template: '<span />' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiContextMenu: {
					props: ['items'],
					template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
				},
				PostboxSnoozeDialog: { template: '<span />' },
				PostboxLabelPickerDialog: { template: '<span />' },
				PostboxMovePickerDialog: { template: '<span />' },
				PostboxSwipeTrack: { template: '<div />' },
				PostboxThreadRowFollowUp: { template: '<span />' },
				UiAvatar: { template: '<span />' },
			},
			mocks: { resolveComponent: () => 'div' },
		},
	});
	layoutRows(w);
	return w;
}

/** Give the rendered rows a vertical layout, ROW_PX apart, in DOM order. */
function layoutRows(w: ReturnType<typeof mount>) {
	for (const [i, row] of w.findAll('[data-sweep-row]').entries()) {
		row.element.getBoundingClientRect = () =>
			({ top: i * ROW_PX, bottom: (i + 1) * ROW_PX }) as DOMRect;
	}
}

function pointer(type: string, y: number): PointerEvent {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: 20 },
		clientY: { value: y },
		pointerType: { value: 'mouse' },
		pointerId: { value: 1 },
		isPrimary: { value: true },
		button: { value: 0 },
	});
	return event as PointerEvent;
}

const midOf = (i: number) => i * ROW_PX + ROW_PX / 2;

/** Press the handle on row `from`, drag to row `to`; release unless told not to. */
async function sweep(
	w: ReturnType<typeof mountList>,
	handle: 'select' | 'archive',
	from: number,
	to: number,
	release = true
) {
	const rows = w.findAll('[data-sweep-row]');
	rows[from]!.find(`[data-sweep-handle="${handle}"]`).element.dispatchEvent(
		pointer('pointerdown', midOf(from))
	);
	window.dispatchEvent(pointer('pointermove', midOf(from) + 10));
	window.dispatchEvent(pointer('pointermove', midOf(to)));
	await flushPromises();
	if (release) {
		window.dispatchEvent(pointer('pointerup', midOf(to)));
		await flushPromises();
	}
}

const archiveCalls = () =>
	runSpy.mock.calls
		.map(([args]) => args as { messageIds?: string[] })
		.filter((args) => Array.isArray(args.messageIds));

describe('PostboxThreadList sweep', () => {
	it('archives the swept range in one mutation, and only on release', async () => {
		const w = mountList([1, 2, 3, 4, 5].map((i) => makeMessage(i)));
		await sweep(w, 'archive', 1, 3, false);

		expect(archiveCalls()).toEqual([]);
		expect(w.findAll('[data-sweep-mark="archive"]')).toHaveLength(3);
		expect(document.querySelector('[data-testid="postbox-sweep-status"]')?.textContent).toContain(
			'Archive 3 messages'
		);

		window.dispatchEvent(pointer('pointerup', midOf(3)));
		await flushPromises();
		expect(archiveCalls()).toEqual([{ messageIds: ['msg-2', 'msg-3', 'msg-4'] }]);
		expect(document.querySelector('[data-testid="postbox-sweep-status"]')).toBeNull();
	});

	it('the click the release leaves on the Archive button does not archive again', async () => {
		const w = mountList([1, 2, 3].map((i) => makeMessage(i)));
		await sweep(w, 'archive', 0, 0, false);
		const button = w.findAll('[data-sweep-row]')[0]!.find('[data-sweep-handle="archive"]');
		// The browser sends the click in the same task as the pointerup.
		window.dispatchEvent(pointer('pointerup', midOf(0)));
		button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushPromises();
		expect(archiveCalls()).toEqual([{ messageIds: ['msg-1'] }]);
	});

	it('writes a checkbox sweep to the selection in one step', async () => {
		const w = mountList([1, 2, 3, 4].map((i) => makeMessage(i)));
		await sweep(w, 'select', 3, 1);
		expect(setRange).toHaveBeenCalledTimes(1);
		expect(setRange).toHaveBeenCalledWith(['msg-2', 'msg-3', 'msg-4'], true, 'msg-4');
		expect(archiveCalls()).toEqual([]);
	});

	it('an Archive sweep stays inside the mailbox it started in', async () => {
		const w = mountList([
			makeMessage(1),
			makeMessage(2, 'mailbox-2'),
			makeMessage(3),
			makeMessage(4),
		]);
		await sweep(w, 'archive', 0, 3);
		expect(archiveCalls()).toEqual([{ messageIds: ['msg-1', 'msg-3', 'msg-4'] }]);
	});

	it('Esc mid-sweep archives nothing', async () => {
		const w = mountList([1, 2, 3].map((i) => makeMessage(i)));
		await sweep(w, 'archive', 0, 2, false);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		window.dispatchEvent(pointer('pointerup', midOf(2)));
		await flushPromises();
		expect(archiveCalls()).toEqual([]);
		expect(w.findAll('[data-sweep-mark]')).toHaveLength(0);
	});

	it('unmounting mid-sweep leaves nothing listening', async () => {
		const w = mountList([1, 2, 3].map((i) => makeMessage(i)));
		await sweep(w, 'archive', 0, 2, false);
		w.unmount();
		window.dispatchEvent(pointer('pointerup', midOf(2)));
		await flushPromises();
		expect(archiveCalls()).toEqual([]);
	});
});
