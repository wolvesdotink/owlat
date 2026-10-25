import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Autosave through the email editor bridge (useEmailEditorAutosave.ts): a
// draft's session owns it, classic and co-edited. It saves after a pause in
// the edits, offers copies left on the device (never applies them), decides
// leaving through the real unsaved-changes guard, and drops only this tab's
// unsent work on Discard. Convex is a fake client with controllable query
// results; fake timers throughout.

vi.mock('@owlat/email-builder', () => ({
	provideEmailBuilderHandlers: vi.fn(),
}));
vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mediaAssets: { create: 'mediaAssets.create' },
		emailBlocks: { blocks: { create: 'emailBlocks.blocks.create' } },
		emailCoediting: {
			sessions: {
				get: 'sessions.get',
				open: 'sessions.open',
				applyOps: 'sessions.applyOps',
				reset: 'sessions.reset',
			},
			presence: { heartbeat: 'presence.heartbeat', leave: 'presence.leave', list: 'presence.list' },
			notices: { listForClient: 'notices.listForClient', dismiss: 'notices.dismiss' },
		},
	},
}));
const routeLeave = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({
	onBeforeRouteLeave: routeLeave,
	useRouter: () => ({ push: vi.fn() }),
}));
// A test that needs device copies sets `draftStore`; the rest run without one.
let draftStore: EditorDraftStore | null = null;
vi.mock('~/utils/editorDraftStore', async (importOriginal) => {
	const actual: { getEditorDraftStore: () => EditorDraftStore } = await importOriginal();
	return { ...actual, getEditorDraftStore: () => draftStore ?? actual.getEditorDraftStore() };
});

import { ref, nextTick, onMounted, onUnmounted, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { useEmailEditorBridge, type EmailEditorSaveBase } from '../useEmailEditorBridge';
import { useUnsavedChanges } from '../useUnsavedChanges';
import { StaleDraftError } from '../useEditorSaveOperation';
import { withSetup } from '~/__tests__/withSetup';
import {
	createEditorDraftStore,
	editorDraftKey,
	editorDraftScope,
	type EditorDraftStore,
} from '~/utils/editorDraftStore';
import { createNoopDriver } from '~/utils/postboxOfflineKvDriver';

interface TemplateRow {
	_id: string;
	name: string;
	subject: string;
	content: string;
	status: 'draft' | 'published';
	contentRevision?: number;
}

interface SessionRow {
	sessionId: string;
	version: number;
	savedVersion: number;
	baseRevision: number;
	content: string;
	fields: string;
}

const text = (id: string, html: string) =>
	({ id, type: 'text', content: { html } }) as unknown as EditorBlock;

function sessionRow(version: number, savedVersion: number, extra: Partial<SessionRow> = {}) {
	return {
		sessionId: 's1',
		version,
		savedVersion,
		baseRevision: 2,
		content: JSON.stringify([text('a', 'Alpha')]),
		fields: JSON.stringify({ name: 'Welcome', subject: 'Hello' }),
		...extra,
	};
}

let queries: Record<string, Ref<unknown>>;
let mutation: ReturnType<typeof vi.fn>;
let canCoedit: boolean;
let showToast: ReturnType<typeof vi.fn>;

/** A device-copy store held in memory, holding `entries`. */
function memoryStore(entries: Record<string, unknown>): EditorDraftStore {
	const data = new Map(Object.entries(entries));
	return createEditorDraftStore({
		...createNoopDriver(),
		persistent: true,
		get: async <T>(key: string) => data.get(key) as T,
		set: async (key, value) => {
			data.set(key, value);
		},
		delete: async (key) => {
			data.delete(key);
		},
		keys: async () => [...data.keys()],
		deleteIf: async (key, predicate) => {
			if (!predicate(data.get(key))) return false;
			data.delete(key);
			return true;
		},
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	queries = {
		'sessions.get': ref(undefined),
		'presence.list': ref({ now: Date.now(), people: [] }),
		'notices.listForClient': ref([]),
	};
	canCoedit = false;
	draftStore = null;
	showToast = vi.fn();
	mutation = vi.fn(async (fn: string) => {
		if (fn === 'sessions.applyOps') return { version: 2 };
		if (fn === 'presence.heartbeat') return { isLeaseHeld: false, heldBy: null };
		return null;
	});
	vi.stubGlobal('onMounted', onMounted);
	vi.stubGlobal('onUnmounted', onUnmounted);
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: ref('en'), te: () => true }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useAuth', () => ({
		user: ref({ id: 'user_1' }),
		activeOrganizationId: ref('org_1'),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	// The real guard: a draft's leave decisions go through it.
	vi.stubGlobal('useUnsavedChanges', useUnsavedChanges);
	routeLeave.mockClear();
	vi.stubGlobal('useKeyboardShortcuts', () => ({
		registerSaveShortcut: vi.fn(),
		unregisterShortcut: vi.fn(),
	}));
	vi.stubGlobal('useConvex', () => ({ mutation }));
	vi.stubGlobal('useConvexQuery', (fn: string, args: () => unknown) => ({
		data: {
			get value() {
				return args() === 'skip' ? undefined : (queries[fn] ?? ref(undefined)).value;
			},
			__v_isRef: true,
		},
	}));
	vi.stubGlobal('usePermissions', () => ({ can: () => canCoedit, isRoleLoading: ref(false) }));
	vi.stubGlobal('useOrganization', () => ({
		members: ref([]),
		hasResolvedMembers: ref(true),
		fetchMembers: vi.fn(),
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function setup(status: 'draft' | 'published' = 'draft', initial: Partial<TemplateRow> = {}) {
	const source = ref<TemplateRow | null>({
		_id: 't1',
		name: 'Welcome',
		subject: 'Hello',
		content: JSON.stringify([text('a', 'Alpha')]),
		status,
		contentRevision: 2,
		...initial,
	});
	const save = vi.fn(
		async (ctx: { subject: Ref<string> }, base: EmailEditorSaveBase<TemplateRow | null>) => {
			// The server trims what it stores; the echo arrives before the save resolves.
			const revision = (base.revision ?? 0) + 1;
			source.value = {
				...source.value!,
				subject: ctx.subject.value.trim(),
				contentRevision: revision,
			};
			await nextTick();
			return revision;
		}
	);
	const { result: bridge, unmount } = withSetup(() =>
		useEmailEditorBridge({
			source,
			revision: (row) => row.contentRevision ?? 0,
			coedit: { target: () => ({ type: 'emailTemplate', id: 't1' as never }), fields: {} },
			autosave: {
				enabled: () => source.value?.status === 'draft',
				kind: 'emailTemplate',
				id: () => 't1',
			},
			initialize: (row, ctx) => {
				ctx.name.value = row.name;
				ctx.subject.value = row.subject;
				ctx.blocks.value = JSON.parse(row.content) as EditorBlock[];
			},
			save,
		})
	);
	return { source, save, bridge, unmount };
}

const settle = async () => {
	await nextTick();
	await nextTick();
};

/** Runs the page's leave guards in order; resolves what the first refusal (if any) said. */
async function leave(to = '/dashboard/send') {
	for (const [guard] of routeLeave.mock.calls) {
		let answer: unknown = 'none';
		await guard({ fullPath: to }, {}, (value?: unknown) => {
			answer = value;
		});
		if (answer === false) return 'blocked';
	}
	return 'left';
}

const scope = editorDraftScope({
	userId: 'user_1',
	organizationId: 'org_1',
	kind: 'emailTemplate',
	id: 't1',
});

/** A copy another editor (closed) left behind on `base`. */
function leftBehind(base: number, data: Record<string, unknown>) {
	return {
		[editorDraftKey(scope, 'tab-old.1')]: {
			v: 1,
			savedAt: Date.now(),
			base,
			data: { name: 'Welcome', subject: 'Hello', blocks: [text('a', 'Alpha')], extra: [], ...data },
		},
	};
}

describe('useEmailEditorBridge autosave (classic)', () => {
	it('saves a draft after the pause, quietly, and keeps the text as typed', async () => {
		const { bridge, save, unmount } = setup();
		await settle();
		bridge.subject.value = 'Hello there ';
		await nextTick();
		expect(save).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1500);
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0]?.[1]).toMatchObject({ revision: 2, autosave: true });
		// The trimmed echo of its own save does not eat the space being typed.
		expect(bridge.subject.value).toBe('Hello there ');
		expect(bridge.hasChanges.value).toBe(false);
		expect(bridge.autosave?.autosave.status.value).toBe('saved');

		bridge.subject.value = 'Hello there friend';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(save.mock.calls[1]?.[1]).toMatchObject({ revision: 3, autosave: true });
		unmount();
	});

	it('keeps the text as typed when the acknowledgement comes before the echo', async () => {
		const { bridge, save, source, unmount } = setup();
		save.mockImplementationOnce(async () => 3);
		await settle();
		bridge.subject.value = 'Typed ';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		source.value = { ...source.value!, subject: 'Typed', contentRevision: 3 };
		await settle();
		expect(bridge.subject.value).toBe('Typed ');
		expect(bridge.hasChanges.value).toBe(false);
		unmount();
	});

	it('saves nothing of a discarded edit, also when the editor closes right after', async () => {
		draftStore = createEditorDraftStore(createNoopDriver());
		const { bridge, save, unmount } = setup();
		await settle();
		bridge.subject.value = 'Discarded';
		await nextTick();
		expect(await leave()).toBe('blocked');
		bridge.confirmDiscard();
		unmount();
		await vi.advanceTimersByTimeAsync(5000);
		expect(save).not.toHaveBeenCalled();
	});

	it("saves the leave prompt's Save through the autosave queue", async () => {
		draftStore = createEditorDraftStore(createNoopDriver());
		const { bridge, save, unmount } = setup();
		await settle();
		bridge.subject.value = 'Before leaving';
		await nextTick();
		expect(await leave()).toBe('blocked');
		await bridge.confirmSave();
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0]?.[1]).toMatchObject({ revision: 2, autosave: true });
		expect(bridge.autosave?.autosave.atRisk.value).toBe(false);

		// A Save that did not land keeps the prompt and says so.
		save.mockRejectedValueOnce(new Error('offline'));
		bridge.subject.value = 'Not saved';
		await nextTick();
		expect(await leave()).toBe('blocked');
		await bridge.confirmSave();
		expect(bridge.showUnsavedChangesDialog.value).toBe(true);
		expect(showToast).toHaveBeenCalledWith('shared.draftAutosave.notSavedYet', 'error');
		unmount();
	});

	it('shares one queue between a background save, the prompt, the shortcut and Publish', async () => {
		draftStore = createEditorDraftStore(createNoopDriver());
		const { bridge, save, unmount } = setup();
		let release!: () => void;
		save.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(3);
				})
		);
		await settle();
		bridge.subject.value = 'One';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(save).toHaveBeenCalledOnce();
		bridge.subject.value = 'Two';
		await nextTick();
		await leave();
		const prompt = bridge.confirmSave();
		const shortcut = bridge.requestSave();
		const publish = bridge.autosave!.autosave.runAction(() => bridge.autosave!.autosave.flush());
		await vi.advanceTimersByTimeAsync(0);
		expect(save).toHaveBeenCalledOnce();
		release();
		await Promise.all([prompt, shortcut, publish]);
		expect(save).toHaveBeenCalledTimes(2);
		expect(
			save.mock.calls.map(([ctx]) => (ctx as { subject: { value: string } }).subject.value)
		).toEqual(['Two', 'Two']);
		expect(save.mock.calls[1]?.[1]).toMatchObject({ revision: 3 });
		unmount();
	});

	it('offers a copy left on the revision the server still holds, and applies nothing', async () => {
		draftStore = memoryStore(leftBehind(2, { subject: 'Offline subject' }));
		const { bridge, save, unmount } = setup();
		await settle();
		await vi.advanceTimersByTimeAsync(0);
		expect(bridge.subject.value).toBe('Hello');
		expect(bridge.autosave?.recovery.pending.value?.data).toMatchObject({
			subject: 'Offline subject',
		});
		await vi.advanceTimersByTimeAsync(1500);
		expect(save).not.toHaveBeenCalled();

		// Restore: an edit like any other, saved on the revision the draft is built on.
		bridge.autosave?.recovery.restore();
		await settle();
		expect(bridge.subject.value).toBe('Offline subject');
		await vi.advanceTimersByTimeAsync(1500);
		expect(save.mock.calls[0]?.[1]).toMatchObject({ revision: 2, autosave: true });
		unmount();
	});

	it('offers a copy while text is typed into a block, and never loads it into the canvas', async () => {
		draftStore = memoryStore(leftBehind(2, { blocks: [] }));
		const { bridge, unmount } = setup();
		const loadState = vi.fn();
		bridge.builderRef.value = { loadState, isInlineEditing: true };
		await settle();
		await vi.advanceTimersByTimeAsync(0);
		expect(loadState).not.toHaveBeenCalled();
		expect(bridge.autosave?.recovery.pending.value?.data).toMatchObject({ blocks: [] });
		unmount();
	});

	it('asks before Restore replaces text typed into a block, and closes that text first', async () => {
		draftStore = memoryStore(leftBehind(2, { blocks: [] }));
		const { bridge, unmount } = setup();
		await settle();
		await vi.advanceTimersByTimeAsync(0);
		expect(bridge.autosave?.recovery.pending.value).not.toBeNull();
		const calls: string[] = [];
		const loadState = vi.fn(() => calls.push('loadState'));
		bridge.builderRef.value = {
			loadState,
			isInlineEditing: true,
			commitInlineEdit: () => {
				calls.push('commit');
				(bridge.builderRef.value as { isInlineEditing: boolean }).isInlineEditing = false;
			},
		};
		await nextTick();

		bridge.autosave!.recovery.restore();
		expect(loadState).not.toHaveBeenCalled();
		expect(bridge.autosave!.recovery.confirm.value).toBe(true);

		bridge.autosave!.recovery.restore();
		expect(calls).toEqual(['commit', 'loadState']);
		expect(loadState).toHaveBeenCalledWith(expect.objectContaining({ blocks: [] }));
		unmount();
	});

	describe('leaving while text is typed into a block', () => {
		/** The text editor is open with `typed`; closing it puts the text in the subject. */
		const typeInto = (bridge: ReturnType<typeof setup>['bridge'], typed: string) => {
			bridge.builderRef.value = {
				loadState: vi.fn(),
				isInlineEditing: true,
				commitInlineEdit: () => {
					bridge.subject.value = typed;
					(bridge.builderRef.value as { isInlineEditing: boolean }).isInlineEditing = false;
				},
			};
		};

		it('asks before leaving when the text could be kept nowhere', async () => {
			// No device storage, and the save on the way out will fail.
			draftStore = createEditorDraftStore(createNoopDriver());
			const { bridge, save, unmount } = setup();
			save.mockRejectedValue(new Error('offline'));
			await settle();
			typeInto(bridge, 'Typed, not committed');
			await settle();
			expect(bridge.hasChanges.value).toBe(false);

			expect(await leave()).toBe('blocked');
			expect(bridge.subject.value).toBe('Typed, not committed');
			expect(bridge.showUnsavedChangesDialog.value).toBe(true);
			expect(bridge.autosave?.autosave.atRisk.value).toBe(true);
			unmount();
		});

		it('leaves without asking once the text is on the device', async () => {
			draftStore = memoryStore({});
			const { bridge, unmount } = setup();
			await settle();
			typeInto(bridge, 'Typed, kept');
			await settle();

			expect(await leave()).toBe('left');
			expect(bridge.showUnsavedChangesDialog.value).toBe(false);
			expect(bridge.autosave?.autosave.onDevice.value).toBe(true);
			unmount();
		});
	});

	describe('a device copy of edits made before a newer write', () => {
		/** Edits at revision 2; another writer's revision 3 arrives and refuses the save. */
		async function editBeforeTheirWrite() {
			draftStore = memoryStore({});
			const first = setup();
			first.save.mockRejectedValue(new StaleDraftError(3));
			await settle();
			first.bridge.subject.value = 'My subject';
			await settle();
			first.source.value = { ...first.source.value!, subject: 'Their subject', contentRevision: 3 };
			await settle();
			await vi.advanceTimersByTimeAsync(1500);
			expect(first.bridge.conflict.value).toEqual({ currentRevision: 3 });
			const copies = await draftStore.list(scope, (data): data is unknown => true);
			expect(copies).toHaveLength(1);
			return { first, copy: copies[0]! };
		}

		it('names the revision the edits were built on', async () => {
			const { first, copy } = await editBeforeTheirWrite();
			expect(copy.base).toBe(2);
			first.unmount();
		});

		it('is offered on reopen, not applied over the newer write', async () => {
			const { first } = await editBeforeTheirWrite();
			first.unmount();
			const reopened = setup('draft', { subject: 'Their subject', contentRevision: 3 });
			await settle();
			await vi.advanceTimersByTimeAsync(0);

			expect(reopened.bridge.subject.value).toBe('Their subject');
			expect(reopened.bridge.autosave?.recovery.pending.value?.data).toMatchObject({
				subject: 'My subject',
			});
			await vi.advanceTimersByTimeAsync(1500);
			expect(reopened.save).not.toHaveBeenCalled();
			reopened.unmount();
		});

		it('names the newer revision once "keep my version" built the edits on it', async () => {
			const { first } = await editBeforeTheirWrite();
			// Its save does not land: the copy is what keeps the edits.
			first.save.mockReset();
			first.save.mockRejectedValue(new Error('offline'));
			await first.bridge.keepMyVersion();
			first.bridge.subject.value = 'My subject, kept';
			await settle();
			await vi.advanceTimersByTimeAsync(1500);
			const copies = await draftStore!.list(scope, (data): data is unknown => true);
			expect(copies.map(({ base }) => base)).toEqual([3]);
			expect(first.save.mock.calls.at(-1)?.[1]).toMatchObject({ revision: 3 });
			first.unmount();
		});
	});

	it('leaves a published email to its explicit Save', async () => {
		const { bridge, save, unmount } = setup('published');
		await settle();
		bridge.subject.value = 'Edited';
		await nextTick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(save).not.toHaveBeenCalled();
		expect(bridge.autosave?.autosave.status.value).toBe('idle');
		expect(bridge.hasChanges.value).toBe(true);
		unmount();
	});

	it('hands the draft to the manual Save when the template is published, and back', async () => {
		const { bridge, save, source, unmount } = setup();
		await settle();
		source.value = { ...source.value!, status: 'published' };
		await settle();
		bridge.subject.value = 'Edited while published';
		await settle();
		expect(bridge.hasChanges.value).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(save).not.toHaveBeenCalled();
		// Unpublished again: the draft's session takes the unsaved edit over and saves it.
		source.value = { ...source.value!, status: 'draft' };
		await settle();
		await vi.advanceTimersByTimeAsync(1500);
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0]?.[1]).toMatchObject({ revision: 2, autosave: true });
		unmount();
	});

	it('waits for the choice while a stale-revision conflict is open', async () => {
		const { bridge, save, unmount } = setup();
		save.mockRejectedValueOnce(new StaleDraftError(5));
		await settle();
		bridge.subject.value = 'Mine';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(bridge.conflict.value).toEqual({ currentRevision: 5 });

		bridge.subject.value = 'Mine, more';
		await nextTick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(save).toHaveBeenCalledOnce();
		unmount();
	});
});

describe('useEmailEditorBridge autosave (co-editing)', () => {
	async function joined() {
		canCoedit = true;
		const t = setup();
		queries['sessions.get']!.value = sessionRow(1, 1);
		await settle();
		await settle();
		expect(t.bridge.coediting?.status.value).toBe('active');
		return t;
	}

	it("saves the session after this tab's own edit", async () => {
		const { bridge, save, unmount } = await joined();
		bridge.blocks.value = [text('a', 'Alpha edited')];
		await settle();
		// The edit goes to the session first…
		await vi.advanceTimersByTimeAsync(300);
		queries['sessions.get']!.value = sessionRow(2, 1);
		await settle();
		// …and the session is written to the email after the pause.
		await vi.advanceTimersByTimeAsync(1500);
		queries['sessions.get']!.value = sessionRow(2, 2, { baseRevision: 3 });
		await vi.advanceTimersByTimeAsync(0);
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0]?.[1]).toMatchObject({ coeditVersion: 2, autosave: true });
		unmount();
	});

	it('names the revision the session is built on in the device copy', async () => {
		draftStore = memoryStore({});
		const { bridge, source, unmount } = await joined();
		bridge.blocks.value = [text('a', 'Alpha edited')];
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		queries['sessions.get']!.value = sessionRow(2, 1);
		await settle();
		// The email moves on outside the session (an API write) before the next copy.
		source.value = { ...source.value!, contentRevision: 3 };
		bridge.blocks.value = [text('a', 'Alpha edited again')];
		await settle();
		await vi.advanceTimersByTimeAsync(300);

		const copies = await draftStore.list(scope, (data): data is unknown => true);
		expect(copies.map(({ base }) => base)).toEqual([2]);
		unmount();
	});

	it('counts an edit from the keystroke, before it goes to the session', async () => {
		draftStore = createEditorDraftStore(createNoopDriver());
		const { bridge, unmount } = await joined();
		const autosave = bridge.autosave!.autosave;
		const before = autosave.state.value.localRevision;
		bridge.subject.value = 'Hello again';
		await settle();
		// The edit reaches the session 250 ms later; until then it is nowhere else.
		expect(calls('sessions.applyOps')).toHaveLength(0);
		expect(autosave.state.value.localRevision).toBeGreaterThan(before);
		expect(autosave.atRisk.value).toBe(true);
		// Closing the tab now asks, read at once.
		expect(autosave.leave.isAtRisk()).toBe(true);
		unmount();
	});

	const someoneElseJoins = async () => {
		queries['presence.list']!.value = {
			now: Date.now(),
			people: [
				{ clientId: 'other', userId: 'user-b', heartbeatAt: Date.now(), leaseBlockId: null },
			],
		};
		await settle();
	};
	const calls = (fn: string) => mutation.mock.calls.filter(([name]) => name === fn);

	it('holds new session sends while the leave prompt is open, and Discard drops them', async () => {
		draftStore = createEditorDraftStore(createNoopDriver());
		const { bridge, save, unmount } = await joined();
		await someoneElseJoins();
		bridge.subject.value = 'Not yet shared';
		await nextTick();
		expect(await leave()).toBe('blocked');
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls('sessions.applyOps')).toHaveLength(0);
		bridge.confirmDiscard();
		unmount();
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls('sessions.applyOps')).toHaveLength(0);
		expect(calls('sessions.reset')).toHaveLength(0);
		expect(save).not.toHaveBeenCalled();
	});

	it('sends the held edit once the person stays', async () => {
		draftStore = createEditorDraftStore(createNoopDriver());
		const { bridge, unmount } = await joined();
		bridge.subject.value = 'Stay';
		await nextTick();
		expect(await leave()).toBe('blocked');
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls('sessions.applyOps')).toHaveLength(0);
		bridge.cancelNavigation();
		await vi.advanceTimersByTimeAsync(300);
		expect(calls('sessions.applyOps')).toHaveLength(1);
		unmount();
	});

	it.each([
		['alone', false],
		['when someone joins during the choice', true],
	])('never resets the shared session on Discard (%s)', async (_, joins) => {
		draftStore = createEditorDraftStore(createNoopDriver());
		const { bridge, save, unmount } = await joined();
		bridge.subject.value = 'Discarded';
		await settle();
		expect(await leave()).toBe('blocked');
		if (joins) await someoneElseJoins();
		bridge.confirmDiscard();
		await settle();
		unmount();
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls('sessions.reset')).toHaveLength(0);
		expect(calls('sessions.applyOps')).toHaveLength(0);
		expect(save).not.toHaveBeenCalled();
	});

	it("leaves another person's edit to their tab while they are here", async () => {
		const { save, unmount } = await joined();
		await someoneElseJoins();
		queries['sessions.get']!.value = sessionRow(2, 1, {
			content: JSON.stringify([text('a', 'Their edit')]),
		});
		await settle();
		await vi.advanceTimersByTimeAsync(5000);
		expect(save).not.toHaveBeenCalled();
		unmount();
	});

	it('treats a stale refusal as done when the other save already wrote what this tab saw', async () => {
		const { bridge, save, unmount } = await joined();
		save.mockImplementationOnce(async () => {
			// The other tab's save landed first and moved the session's saved version on.
			queries['sessions.get']!.value = sessionRow(2, 2, { baseRevision: 3 });
			throw new StaleDraftError(3);
		});
		bridge.blocks.value = [text('a', 'Alpha edited')];
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		queries['sessions.get']!.value = sessionRow(2, 1);
		await settle();
		await vi.advanceTimersByTimeAsync(1500);
		await vi.advanceTimersByTimeAsync(0);

		expect(save).toHaveBeenCalledOnce();
		expect(bridge.conflict.value).toBeNull();
		expect(bridge.autosave?.autosave.status.value).toBe('saved');
		unmount();
	});

	it.each([
		['another session', { sessionId: 's2' }],
		['a saved version short of what this tab saw', {}],
	])('keeps the conflict when the other save was %s', async (_, other) => {
		const { bridge, save, unmount } = await joined();
		save.mockImplementationOnce(async () => {
			queries['sessions.get']!.value = sessionRow(2, 1, { baseRevision: 3, ...other });
			throw new StaleDraftError(3);
		});
		bridge.blocks.value = [text('a', 'Alpha edited')];
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		queries['sessions.get']!.value = sessionRow(2, 1);
		await settle();
		await vi.advanceTimersByTimeAsync(1500);
		await vi.advanceTimersByTimeAsync(7000);
		expect(bridge.conflict.value).toEqual({ currentRevision: 3 });
		expect(bridge.autosave?.autosave.atRisk.value).toBe(true);
		unmount();
	});

	it('opens the conflict when the email moved on outside the session', async () => {
		const { bridge, save, unmount } = await joined();
		save.mockRejectedValueOnce(new StaleDraftError(7));
		bridge.blocks.value = [text('a', 'Alpha edited')];
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		queries['sessions.get']!.value = sessionRow(2, 1);
		await settle();
		await vi.advanceTimersByTimeAsync(1500);
		// `untilSaved` gives the session a moment to report a save; none comes.
		await vi.advanceTimersByTimeAsync(7000);

		expect(bridge.conflict.value).toEqual({ currentRevision: 7 });
		unmount();
	});
});
