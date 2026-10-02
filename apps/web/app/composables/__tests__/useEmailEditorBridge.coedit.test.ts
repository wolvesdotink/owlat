import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Co-editing through the email editor bridge (docs/adr/0071-email-coediting.md):
// the canvas follows the shared session, local edits go out as block
// operations, other people's edits come in through the builder's
// applyRemoteOps, and Save writes the session. Convex is replaced by a fake
// client and controllable query results.

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

import { ref, nextTick, onMounted, onUnmounted, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { useEmailEditorBridge } from '../useEmailEditorBridge';
import { withSetup } from '~/__tests__/withSetup';

interface TemplateRow {
	_id: string;
	name: string;
	subject: string;
	content: string;
	plainTextOverride?: string;
	contentRevision?: number;
}

const text = (id: string, html: string) =>
	({ id, type: 'text', content: { html } }) as unknown as EditorBlock;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SessionRow {
	sessionId: string;
	version: number;
	savedVersion: number;
	baseRevision: number;
	content: string;
	fields: string;
}

function sessionRow(
	version: number,
	blocks: EditorBlock[],
	extra: Partial<SessionRow> = {}
): SessionRow {
	return {
		sessionId: 's1',
		version,
		savedVersion: 1,
		baseRevision: 2,
		content: JSON.stringify(blocks),
		fields: JSON.stringify({ name: 'Welcome', subject: 'Hello', plainTextOverride: '' }),
		...extra,
	};
}

let queries: Record<string, Ref<unknown>>;
let mutation: ReturnType<typeof vi.fn>;
let canManage: boolean;

beforeEach(() => {
	queries = {
		'sessions.get': ref(undefined),
		'presence.list': ref({ now: Date.now(), people: [] }),
		'notices.listForClient': ref([]),
	};
	canManage = true;
	mutation = vi.fn(async (fn: string) => {
		if (fn === 'sessions.applyOps') return { version: 2 };
		if (fn === 'presence.heartbeat') return { isLeaseHeld: false, heldBy: null };
		return null;
	});
	// The suite's setup file installs these as globals; unstubAllGlobals drops them.
	vi.stubGlobal('onMounted', onMounted);
	vi.stubGlobal('onUnmounted', onUnmounted);
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: ref('en'), te: () => true }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
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
		data: computedQuery(fn, args),
	}));
	vi.stubGlobal('usePermissions', () => ({ can: () => canManage, isRoleLoading: ref(false) }));
	vi.stubGlobal('useOrganization', () => ({
		members: ref([
			{ userId: 'user-b', user: { name: 'Bea', email: 'bea@example.com', image: null } },
		]),
		hasResolvedMembers: ref(true),
		fetchMembers: vi.fn(),
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A query result that is undefined while its args are 'skip'. */
function computedQuery(fn: string, args: () => unknown) {
	const data = queries[fn] ?? ref(undefined);
	return {
		get value() {
			return args() === 'skip' ? undefined : data.value;
		},
		__v_isRef: true,
	} as unknown as Ref<unknown>;
}

function setup() {
	const source = ref<TemplateRow | null>({
		_id: 't1',
		name: 'Welcome',
		subject: 'Hello',
		content: JSON.stringify([text('a', 'Alpha'), text('b', 'Beta')]),
		contentRevision: 2,
	});
	const plainTextOverride = ref('');
	const save = vi.fn(async () => 3);
	const { result: bridge, unmount } = withSetup(() =>
		useEmailEditorBridge({
			source,
			revision: (row) => row.contentRevision ?? 0,
			extraWatch: [plainTextOverride],
			coedit: {
				target: () => ({ type: 'emailTemplate', id: 't1' as never }),
				fields: { plainTextOverride: plainTextOverride as Ref<unknown> },
			},
			initialize: (row, ctx) => {
				ctx.name.value = row.name;
				ctx.subject.value = row.subject;
				ctx.blocks.value = JSON.parse(row.content) as EditorBlock[];
			},
			save,
		})
	);
	const builder = { loadState: vi.fn(), applyRemoteOps: vi.fn() };
	return { source, save, bridge, builder, unmount };
}

async function settle() {
	await nextTick();
	await nextTick();
}

describe('useEmailEditorBridge with co-editing', () => {
	it('joins the session and shows it instead of the row', async () => {
		const { bridge, unmount } = setup();
		await settle();
		expect(mutation).toHaveBeenCalledWith('sessions.open', {
			target: { type: 'emailTemplate', id: 't1' },
		});
		expect(bridge.isConnecting.value).toBe(true);

		queries['sessions.get']!.value = sessionRow(1, [text('a', 'Shared A')]);
		await settle();
		expect(bridge.isConnecting.value).toBe(false);
		expect(bridge.blocks.value.map((b) => b.id)).toEqual(['a']);
		expect(bridge.hasChanges.value).toBe(false);
		unmount();
	});

	it('sends a local edit as a block operation based on the version it saw', async () => {
		const { bridge, unmount } = setup();
		queries['sessions.get']!.value = sessionRow(1, [text('a', 'Alpha')]);
		await settle();

		bridge.blocks.value = [text('a', 'Alpha edited')];
		await settle();
		expect(bridge.hasChanges.value).toBe(true);
		await wait(400);

		const call = mutation.mock.calls.find(([fn]) => fn === 'sessions.applyOps');
		expect(call?.[1]).toMatchObject({
			target: { type: 'emailTemplate', id: 't1' },
			ops: [{ kind: 'update', afterId: null, baseVersion: 1 }],
		});
		expect(JSON.parse(call?.[1].ops[0].block).content.html).toBe('Alpha edited');
		unmount();
	});

	it("hands other people's edits to the builder without replacing the canvas", async () => {
		const { bridge, builder, unmount } = setup();
		queries['sessions.get']!.value = sessionRow(1, [text('a', 'Alpha')]);
		await settle();
		bridge.builderRef.value = builder;

		queries['sessions.get']!.value = sessionRow(2, [text('a', 'Alpha'), text('n', 'New')]);
		await settle();
		expect(builder.applyRemoteOps).toHaveBeenCalledWith([
			{ kind: 'insert', block: text('n', 'New'), afterId: 'a' },
		]);
		expect(builder.loadState).not.toHaveBeenCalled();
		expect(bridge.hasChanges.value).toBe(true);
		unmount();
	});

	it('saves the session with the version it has seen and its base revision', async () => {
		const { bridge, save, unmount } = setup();
		queries['sessions.get']!.value = sessionRow(4, [text('a', 'Alpha')], { savedVersion: 3 });
		await settle();

		const pending = bridge.save();
		await wait(50);
		queries['sessions.get']!.value = sessionRow(4, [text('a', 'Alpha')], {
			savedVersion: 4,
			baseRevision: 3,
		});
		await pending;

		expect(save).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ revision: 2, coeditVersion: 4 })
		);
		expect(bridge.hasChanges.value).toBe(false);
		unmount();
	});

	it('shows nothing the session query delivered before its own open landed', async () => {
		// `open` drops a session nobody had open for an hour. A state read before
		// it may still be that dropped draft; shown and then replaced by the new
		// session, this tab would push the abandoned changes back in as its own.
		let finishOpen: () => void = () => {};
		mutation.mockImplementation(async (fn: string) => {
			if (fn === 'sessions.open') {
				await new Promise<void>((resolve) => {
					finishOpen = resolve;
				});
			}
			if (fn === 'sessions.applyOps') return { version: 2 };
			return null;
		});
		const { bridge, unmount } = setup();
		queries['sessions.get']!.value = sessionRow(7, [text('a', 'Abandoned draft')], {
			sessionId: 'old',
			savedVersion: 2,
		});
		await settle();
		expect(bridge.isConnecting.value).toBe(true);

		queries['sessions.get']!.value = sessionRow(1, [text('a', 'Alpha')], {
			sessionId: 'new',
			savedVersion: 1,
		});
		finishOpen();
		await settle();
		await settle();
		expect(bridge.isConnecting.value).toBe(false);
		expect(bridge.blocks.value.map((b) => (b.content as { html: string }).html)).toEqual(['Alpha']);
		await wait(400);
		expect(mutation).not.toHaveBeenCalledWith('sessions.applyOps', expect.anything());
		unmount();
	});

	it('edits the classic way when the member may not co-edit', async () => {
		canManage = false;
		const { bridge, unmount } = setup();
		await settle();
		expect(bridge.isConnecting.value).toBe(false);
		expect(bridge.coediting?.status.value).toBe('unavailable');
		expect(bridge.blocks.value.map((b) => b.id)).toEqual(['a', 'b']);
		expect(mutation).not.toHaveBeenCalledWith('sessions.open', expect.anything());
		unmount();
	});
});
