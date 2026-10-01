/**
 * Reader triage moves first (performance plan 1.2).
 *
 * Archive / trash / snooze / snooze-thread / snooze-until-reply / mute / spam
 * on the open message advance to the next conversation and hide its list row
 * BEFORE the mutation lands; the mutation runs in the background. A failure
 * restores the row and returns to the message (unless the user has moved on),
 * and a success keeps the undo toast, whose undo also brings the row back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, effectScope, h, nextTick, provide, ref, type EffectScope } from 'vue';
import { mount } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import { usePostboxOptimisticHide } from '../usePostboxOptimisticHide';
import * as mailUpdaters from '~/lib/mailOptimistic/mailUpdaters';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type Deferred = {
	promise: Promise<BackendOperationResult<unknown>>;
	resolve: (value: BackendOperationResult<unknown>) => void;
};
function deferred(): Deferred {
	let resolve!: Deferred['resolve'];
	const promise = new Promise<BackendOperationResult<unknown>>((r) => (resolve = r));
	return { promise, resolve };
}

const MOVED = {
	moved: [{ messageId: 'm2' as Id<'mailMessages'>, sourceFolderId: 'inbox' as Id<'mailFolders'> }],
};

// Every operation the composable builds, by its (echoed) label key, in
// creation order — snooze and snooze-thread share a label.
let ops: Record<string, Array<{ run: ReturnType<typeof vi.fn>; optimisticUpdate?: unknown }>>;
let pending: Deferred[];
let navigateTo: ReturnType<typeof vi.fn>;
let currentRoute: { value: { path: string } };
let registerMoveBack: ReturnType<typeof vi.fn>;

function op(label: string, index = 0) {
	const found = ops[label]?.[index];
	if (!found) throw new Error(`no operation labelled ${label}`);
	return found;
}

beforeEach(() => {
	ops = {};
	pending = [];
	currentRoute = ref({ path: '/dashboard/postbox/inbox/m2' });
	navigateTo = vi.fn((path: string) => {
		currentRoute.value = { path };
		return Promise.resolve();
	});
	registerMoveBack = vi.fn();
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useRouter', () => ({ currentRoute }));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('usePostboxBulkActions', () => ({ toggle: vi.fn() }));
	vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));
	vi.stubGlobal('usePostboxFolders', () => ({ folders: ref([]) }));
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack }));
	vi.stubGlobal(
		'useBackendOperation',
		(_fn: unknown, opts: { label: () => string; optimisticUpdate?: unknown }) => {
			const entry = {
				run: vi.fn(() => {
					const d = deferred();
					pending.push(d);
					return d.promise;
				}),
				optimisticUpdate: opts.optimisticUpdate,
			};
			(ops[opts.label()] ??= []).push(entry);
			return entry;
		}
	);
});

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await nextTick();
}

type HostOptions = {
	folderRole?: string;
	inPlace?: boolean;
	autoAdvance?: PostboxAutoAdvanceMode;
	thread?: { _id: string; mutedAt?: number } | null;
};

/** The open message m2 in a list m1, m2, m3 — plus that list's optimistic hide. */
async function setup(options: HostOptions = {}) {
	const { usePostboxReaderActions } = await import('../usePostboxReaderActions');
	const items = ref([{ _id: 'm1' }, { _id: 'm2' }, { _id: 'm3' }]);
	const emitted: Array<string | null> = [];
	const scope: EffectScope = effectScope();
	const result = scope.run(() => {
		const list = usePostboxOptimisticHide(items);
		const actions = usePostboxReaderActions({
			getMessage: () => ({ _id: 'm2', subject: 'Hello' }),
			messageId: computed(() => 'm2' as Id<'mailMessages'>),
			mailboxId: computed(() => 'mb' as Id<'mailboxes'>),
			allMessages: computed(() => items.value),
			readerThread: computed(() => options.thread ?? { _id: 't2' }),
			autoAdvance: ref(options.autoAdvance ?? 'next'),
			advance: {
				ids: () => list.visible.value.map((m) => m._id),
				folderRole: () => ('folderRole' in options ? options.folderRole : 'inbox'),
				inPlace: () => options.inPlace,
				emit: (id) => emitted.push(id),
			},
			compose: { reply: vi.fn(), replyAll: vi.fn(), forward: vi.fn() },
		});
		return { list, actions };
	})!;
	return { ...result, items, emitted, scope };
}

const visibleIds = (list: { visible: { value: Array<{ _id: string }> } }) =>
	list.visible.value.map((m) => m._id);

/** Each verb, how to start it, and the operation it runs. */
const VERBS: Array<{
	name: string;
	start: (a: Awaited<ReturnType<typeof setup>>['actions']) => void;
	op: () => { run: ReturnType<typeof vi.fn> };
	thread?: { _id: string; mutedAt?: number } | null;
}> = [
	{
		name: 'archive',
		start: (a) => a.runReaderAction('archive'),
		op: () => op('common.archive'),
	},
	{
		name: 'trash',
		start: (a) => a.runReaderAction('trash'),
		op: () => op('components.postbox.postboxThreadReader.moveToTrashOperation'),
	},
	{
		name: 'snooze (message)',
		start: (a) => a.snoozeOpenMessage(1_000, 'message'),
		op: () => op('components.postbox.postboxThreadReader.snoozeOperation', 0),
	},
	{
		name: 'snooze (thread)',
		start: (a) => a.snoozeOpenMessage(1_000, 'thread'),
		op: () => op('components.postbox.postboxThreadReader.snoozeOperation', 1),
	},
	{
		name: 'snooze until reply',
		start: (a) => a.snoozeOpenMessageUntilReply(1_000),
		op: () => op('components.postbox.postboxThreadReader.snoozeUntilReplyOperation'),
	},
	{
		name: 'mute',
		start: (a) => a.runReaderAction('mute'),
		op: () => op('components.postbox.postboxThreadReader.muteOperation'),
	},
	{
		name: 'spam',
		start: (a) => a.runReaderAction('reportSpam'),
		op: () => op('components.postbox.postboxThreadReader.reportSpam'),
	},
];

describe('usePostboxReaderActions — triage moves first', () => {
	for (const verb of VERBS) {
		it(`${verb.name}: advances and hides the row before the mutation settles`, async () => {
			const { actions, list, scope } = await setup({ thread: verb.thread });
			verb.start(actions);

			// Navigation and the optimistic hide happened synchronously, while
			// the mutation is still in flight.
			expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox/m3');
			expect(visibleIds(list)).toEqual(['m1', 'm3']);
			expect(verb.op().run).toHaveBeenCalledTimes(1);
			expect(pending).toHaveLength(1);

			pending[0]!.resolve({ ok: true, result: null });
			await flush();
			// Success: no second navigation, the row stays hidden until the list drops it.
			expect(navigateTo).toHaveBeenCalledTimes(1);
			expect(visibleIds(list)).toEqual(['m1', 'm3']);
			scope.stop();
		});

		it(`${verb.name}: a failure restores the row and returns to the message`, async () => {
			const { actions, list, scope } = await setup({ thread: verb.thread });
			verb.start(actions);
			expect(visibleIds(list)).toEqual(['m1', 'm3']);

			pending[0]!.resolve({ ok: false });
			await flush();
			expect(visibleIds(list)).toEqual(['m1', 'm2', 'm3']);
			expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/postbox/inbox/m2', {
				replace: true,
			});
			scope.stop();
		});
	}

	it('runs the mutation against the message it left, not the one it opened', async () => {
		const { actions, scope } = await setup();
		actions.runReaderAction('archive');
		expect(op('common.archive').run).toHaveBeenCalledWith({ messageIds: ['m2'] });
		scope.stop();
	});

	it('falls back to the folder when there is no adjacent message', async () => {
		const { actions, list, scope } = await setup({ autoAdvance: 'back-to-list' });
		actions.runReaderAction('archive');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox');
		expect(visibleIds(list)).toEqual(['m1', 'm3']);

		pending[0]!.resolve({ ok: false });
		await flush();
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/postbox/inbox/m2', { replace: true });
		scope.stop();
	});

	it('keeps the undo toast, and undo brings the hidden row back', async () => {
		const { actions, list, scope } = await setup();
		actions.runReaderAction('archive');
		pending[0]!.resolve({ ok: true, result: MOVED });
		await flush();

		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		const entry = registerMoveBack.mock.calls[0]![0];
		expect(entry.label).toBe('components.postbox.postboxThreadReader.undoArchived');
		expect(entry.moved).toEqual(MOVED.moved);
		expect(visibleIds(list)).toEqual(['m1', 'm3']);
		entry.after();
		expect(visibleIds(list)).toEqual(['m1', 'm2', 'm3']);
		scope.stop();
	});

	it('does not register an undo when the mutation failed', async () => {
		const { actions, scope } = await setup();
		actions.runReaderAction('trash');
		pending[0]!.resolve({ ok: false });
		await flush();
		expect(registerMoveBack).not.toHaveBeenCalled();
		scope.stop();
	});

	it('does not pull the user back when they moved on before the failure', async () => {
		const { actions, list, scope } = await setup();
		actions.runReaderAction('archive');
		// The user opens another conversation while the archive is in flight.
		currentRoute.value = { path: '/dashboard/postbox/inbox/m1' };

		pending[0]!.resolve({ ok: false });
		await flush();
		expect(navigateTo).toHaveBeenCalledTimes(1);
		// The row still comes back.
		expect(visibleIds(list)).toEqual(['m1', 'm2', 'm3']);
		scope.stop();
	});

	it('unmuting keeps the reader put and hides nothing', async () => {
		const { actions, list, scope } = await setup({ thread: { _id: 't2', mutedAt: 1 } });
		actions.runReaderAction('mute');
		expect(navigateTo).not.toHaveBeenCalled();
		expect(visibleIds(list)).toEqual(['m1', 'm2', 'm3']);
		scope.stop();
	});

	it('the search preview (no folder) neither hides nor navigates', async () => {
		const { actions, list, scope } = await setup({ folderRole: undefined });
		actions.runReaderAction('archive');
		expect(visibleIds(list)).toEqual(['m1', 'm2', 'm3']);
		pending[0]!.resolve({ ok: false });
		await flush();
		expect(navigateTo).not.toHaveBeenCalled();
		expect(visibleIds(list)).toEqual(['m1', 'm2', 'm3']);
		scope.stop();
	});
});

describe('usePostboxReaderActions — in-place host (Today overlay)', () => {
	async function mountInHost(openId: { value: string | null }) {
		const { usePostboxReaderActions, POSTBOX_READER_HOST_KEY } =
			await import('../usePostboxReaderActions');
		const items = ref([{ _id: 'm1' }, { _id: 'm2' }, { _id: 'm3' }]);
		const emitted: Array<string | null> = [];
		let actions!: ReturnType<typeof usePostboxReaderActions>;
		let list!: ReturnType<typeof usePostboxOptimisticHide<{ _id: string }>>;
		const Reader = defineComponent({
			setup() {
				list = usePostboxOptimisticHide(items);
				actions = usePostboxReaderActions({
					getMessage: () => ({ _id: 'm2', subject: 'Hello' }),
					messageId: computed(() => 'm2' as Id<'mailMessages'>),
					mailboxId: computed(() => 'mb' as Id<'mailboxes'>),
					allMessages: computed(() => items.value),
					readerThread: computed(() => ({ _id: 't2' })),
					autoAdvance: ref<PostboxAutoAdvanceMode>('next'),
					advance: {
						ids: () => list.visible.value.map((m) => m._id),
						folderRole: () => 'inbox',
						inPlace: () => true,
						emit: (id) => {
							emitted.push(id);
							openId.value = id;
						},
					},
					compose: { reply: vi.fn(), replyAll: vi.fn(), forward: vi.fn() },
				});
				return () => h('div');
			},
		});
		const Host = defineComponent({
			setup() {
				provide(POSTBOX_READER_HOST_KEY, {
					openId: () => openId.value,
					open: (id: string) => {
						openId.value = id;
					},
				});
				return () => h(Reader);
			},
		});
		const wrapper = mount(Host);
		return { actions, list: () => list, emitted, wrapper };
	}

	it('swaps in place immediately and reopens the message when the mutation fails', async () => {
		const openId = ref<string | null>('m2');
		const { actions, list, emitted, wrapper } = await mountInHost(openId);
		actions.runReaderAction('archive');

		expect(emitted).toEqual(['m3']);
		expect(navigateTo).not.toHaveBeenCalled();
		expect(visibleIds(list())).toEqual(['m1', 'm3']);

		pending[0]!.resolve({ ok: false });
		await flush();
		expect(openId.value).toBe('m2');
		expect(visibleIds(list())).toEqual(['m1', 'm2', 'm3']);
		wrapper.unmount();
	});

	it('leaves the overlay alone on success', async () => {
		const openId = ref<string | null>('m2');
		const { actions, wrapper } = await mountInHost(openId);
		actions.runReaderAction('archive');
		pending[0]!.resolve({ ok: true, result: null });
		await flush();
		expect(openId.value).toBe('m3');
		wrapper.unmount();
	});
});

describe('usePostboxReaderActions — native optimistic updates (plan 2.2)', () => {
	it('sends each verb with the updater that patches the local store', async () => {
		await setup();
		const reader = 'components.postbox.postboxThreadReader.';
		expect(op('common.archive').optimisticUpdate).toBe(mailUpdaters.optimisticArchive);
		expect(op(`${reader}moveToTrashOperation`).optimisticUpdate).toBe(mailUpdaters.optimisticTrash);
		expect(op(`${reader}star`).optimisticUpdate).toBe(mailUpdaters.optimisticSetStar);
		expect(op(`${reader}markReadOperation`).optimisticUpdate).toBe(mailUpdaters.optimisticMarkRead);
		expect(op(`${reader}snoozeOperation`, 0).optimisticUpdate).toBe(mailUpdaters.optimisticSnooze);
		expect(op(`${reader}snoozeOperation`, 1).optimisticUpdate).toBe(
			mailUpdaters.optimisticSnoozeThread
		);
		expect(op(`${reader}snoozeUntilReplyOperation`).optimisticUpdate).toBe(
			mailUpdaters.optimisticSnoozeUntilReply
		);
		expect(op(`${reader}moveOperation`).optimisticUpdate).toBe(mailUpdaters.optimisticMove);
	});
});

describe('usePostboxReaderActions — Esc closes the open conversation', () => {
	it('goes back to the folder list in the split view, replacing the open', async () => {
		const { actions, emitted } = await setup();
		actions.runReaderAction('close');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
		expect(emitted).toEqual([]);
	});

	it('closes an overlay host in place', async () => {
		const { actions, emitted } = await setup({ inPlace: true });
		actions.runReaderAction('close');
		expect(emitted).toEqual([null]);
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('stays put in the search preview, which has no list to return to', async () => {
		const { actions } = await setup({ folderRole: undefined });
		actions.runReaderAction('close');
		expect(navigateTo).not.toHaveBeenCalled();
	});
});
