import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Autosave through the email editor bridge (useEmailEditorAutosave.ts): a
// draft saves itself after a pause in the edits, classic and co-edited, and a
// co-edited save that another tab's save overtook is not a conflict. Convex
// is a fake client with controllable query results; fake timers throughout.

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
vi.mock('vue-router', () => ({
	onBeforeRouteLeave: vi.fn(),
	useRouter: () => ({ push: vi.fn() }),
}));

import { ref, nextTick, onMounted, onUnmounted, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { useEmailEditorBridge, type EmailEditorSaveBase } from '../useEmailEditorBridge';
import { StaleDraftError } from '../useEditorSaveOperation';
import { withSetup } from '~/__tests__/withSetup';

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

beforeEach(() => {
	vi.useFakeTimers();
	queries = {
		'sessions.get': ref(undefined),
		'presence.list': ref({ now: Date.now(), people: [] }),
		'notices.listForClient': ref([]),
	};
	canCoedit = false;
	mutation = vi.fn(async (fn: string) => {
		if (fn === 'sessions.applyOps') return { version: 2 };
		if (fn === 'presence.heartbeat') return { isLeaseHeld: false, heldBy: null };
		return null;
	});
	vi.stubGlobal('onMounted', onMounted);
	vi.stubGlobal('onUnmounted', onUnmounted);
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: ref('en'), te: () => true }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useAuth', () => ({
		user: ref({ id: 'user_1' }),
		activeOrganizationId: ref('org_1'),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges: vi.fn(),
	}));
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

function setup(status: 'draft' | 'published' = 'draft') {
	const source = ref<TemplateRow | null>({
		_id: 't1',
		name: 'Welcome',
		subject: 'Hello',
		content: JSON.stringify([text('a', 'Alpha')]),
		status,
		contentRevision: 2,
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

	it('leaves a published email to its explicit Save', async () => {
		const { bridge, save, unmount } = setup('published');
		await settle();
		bridge.subject.value = 'Edited';
		await nextTick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(save).not.toHaveBeenCalled();
		expect(bridge.autosave?.autosave.status.value).toBe('idle');
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

	it("leaves another person's edit to their tab while they are here", async () => {
		const { save, unmount } = await joined();
		queries['presence.list']!.value = {
			now: Date.now(),
			people: [
				{ clientId: 'other', userId: 'user-b', heartbeatAt: Date.now(), leaseBlockId: null },
			],
		};
		await settle();
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
