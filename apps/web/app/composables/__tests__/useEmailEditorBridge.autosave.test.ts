import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Autosave through the email editor bridge (useEmailEditorAutosave.ts): a
// draft's session owns it, classic and co-edited. It saves after a pause in
// the edits, decides leaving through the real unsaved-changes guard (it asks
// until the server acknowledged what the editor shows), and drops only this
// tab's unsent work on Discard. Convex is a fake client with controllable
// query results; fake timers throughout.

vi.mock('@owlat/email-builder', () => ({
	provideEmailBuilderHandlers: vi.fn(),
}));
vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mediaAssets: { create: 'mediaAssets.create' },
		emailBlocks: { blocks: { create: 'emailBlocks.blocks.create' } },
		emailTemplates: { emails: { publish: 'emails.publish', unpublish: 'emails.unpublish' } },
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
import { computed, ref, nextTick, onMounted, onUnmounted, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { useEmailEditorBridge, type EmailEditorSaveBase } from '../useEmailEditorBridge';
import { useUnsavedChanges } from '../useUnsavedChanges';
import { useTemplatePublication } from '../useTemplatePublication';
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
let showToast: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers();
	queries = {
		'sessions.get': ref(undefined),
		'presence.list': ref({ now: Date.now(), people: [] }),
		'notices.listForClient': ref([]),
	};
	canCoedit = false;
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
			autosave: { enabled: () => source.value?.status === 'draft' },
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

		it('asks before leaving while the typed text is not saved', async () => {
			const { bridge, unmount } = setup();
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

		it('leaves without asking once Save wrote the typed text', async () => {
			const { bridge, save, unmount } = setup();
			await settle();
			typeInto(bridge, 'Typed, saved');
			await settle();
			await bridge.requestSave();
			expect(save).toHaveBeenCalledOnce();

			expect(await leave()).toBe('left');
			expect(bridge.showUnsavedChangesDialog.value).toBe(false);
			unmount();
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

	it('counts an edit from the keystroke, before it goes to the session', async () => {
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

	it('reads an edit the change watchers have not counted yet, when leaving or unloading', async () => {
		const { bridge, unmount } = await joined();
		bridge.subject.value = 'Not yet sent';
		// No tick: the session's own unsent flag has not caught up.
		expect(bridge.autosave!.autosave.leave.isAtRisk()).toBe(true);
		const unload = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(true);
		expect(await leave()).toBe('blocked');
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

	describe("someone else's unwritten edit in the session", () => {
		const theirSubject = sessionRow(2, 1, {
			fields: JSON.stringify({ name: 'Welcome', subject: 'Bob changed this' }),
		});
		async function withTheirEdit() {
			const t = await joined();
			await someoneElseJoins();
			queries['sessions.get']!.value = theirSubject;
			await settle();
			expect(t.bridge.subject.value).toBe('Bob changed this');
			return t;
		}

		it('is written to the email before Publish, which then publishes that revision', async () => {
			const { bridge, source, save, unmount } = await withTheirEdit();
			// The server writes the session to the email, then reports it saved.
			save.mockImplementationOnce(async (_ctx, base) => {
				const revision = (base.revision ?? 0) + 1;
				source.value = { ...source.value!, subject: 'Bob changed this', contentRevision: revision };
				queries['sessions.get']!.value = { ...theirSubject, savedVersion: 2, baseRevision: 3 };
				await nextTick();
				return revision;
			});
			const publish = vi.fn(async (_args: unknown) => ({ ok: true }));
			vi.stubGlobal('useBackendOperation', () => ({ run: publish, isLoading: ref(false) }));
			const publication = useTemplatePublication({
				templateId: ref('t1' as never),
				template: computed(() => ({ ...source.value!, htmlContent: '<p>Stored</p>' })),
				hasChanges: bridge.hasChanges,
				draft: () => bridge.autosave!.autosave,
			});
			await publication.togglePublication();
			expect(save).toHaveBeenCalledOnce();
			expect(save.mock.calls[0]?.[1]).toMatchObject({ coeditVersion: 2, revision: 2 });
			expect(publish).toHaveBeenCalledOnce();
			expect(publish.mock.calls[0]?.[0]).toMatchObject({ expectedContentRevision: 3 });
			unmount();
		});

		it('stops Publish while the session still holds edits the email does not', async () => {
			const { bridge, source, save, unmount } = await withTheirEdit();
			// The save lands, but the session keeps reporting an unwritten version.
			save.mockImplementation(async (_ctx, base) => (base.revision ?? 0) + 1);
			const publish = vi.fn(async (_args: unknown) => ({ ok: true }));
			vi.stubGlobal('useBackendOperation', () => ({ run: publish, isLoading: ref(false) }));
			const publication = useTemplatePublication({
				templateId: ref('t1' as never),
				template: computed(() => ({ ...source.value!, htmlContent: '<p>Stored</p>' })),
				hasChanges: bridge.hasChanges,
				draft: () => bridge.autosave!.autosave,
			});
			const done = publication.togglePublication();
			// Each save waits a bounded while for the session to report it written.
			await vi.advanceTimersByTimeAsync(30_000);
			await done;
			expect(save).toHaveBeenCalled();
			expect(publish).not.toHaveBeenCalled();
			expect(showToast).toHaveBeenCalledWith('shared.draftAutosave.notSavedYet', 'error');
			unmount();
		});

		/** The server writes the session to the email on the next save, then reports it saved. */
		const writesTheSession =
			(source: Ref<TemplateRow | null>) =>
			async (_ctx: unknown, base: EmailEditorSaveBase<TemplateRow | null>) => {
				const revision = (base.revision ?? 0) + 1;
				source.value = { ...source.value!, subject: 'Bob changed this', contentRevision: revision };
				queries['sessions.get']!.value = { ...theirSubject, savedVersion: 2, baseRevision: 3 };
				await nextTick();
				return revision;
			};

		it('is not saved: the status says so, and leaving asks, read at once', async () => {
			const { bridge, save, unmount } = await withTheirEdit();
			const autosave = bridge.autosave!.autosave;
			// Their tab writes it in the background, not this one…
			await vi.advanceTimersByTimeAsync(5000);
			expect(save).not.toHaveBeenCalled();
			// …but until it is written, nothing here says Saved or lets the page go quietly.
			expect(autosave.status.value).toBe('unsaved');
			expect(autosave.leave.isAtRisk()).toBe(true);
			expect(await leave()).toBe('blocked');
			unmount();
		});

		it("is written by the prompt's Save, which then lets the page go", async () => {
			const { bridge, source, save, unmount } = await withTheirEdit();
			save.mockImplementationOnce(writesTheSession(source));
			expect(await leave()).toBe('blocked');
			await bridge.confirmSave();
			expect(save).toHaveBeenCalledOnce();
			expect(save.mock.calls[0]?.[1]).toMatchObject({ coeditVersion: 2, autosave: true });
			expect(bridge.showUnsavedChangesDialog.value).toBe(false);
			expect(bridge.autosave!.autosave.atRisk.value).toBe(false);
			expect(await leave()).toBe('left');
			unmount();
		});

		it("asks again when their next edit arrives after the prompt's Save", async () => {
			const { bridge, source, save, unmount } = await withTheirEdit();
			save.mockImplementationOnce(writesTheSession(source));
			expect(await leave()).toBe('blocked');
			await bridge.confirmSave();
			queries['sessions.get']!.value = sessionRow(3, 2, {
				baseRevision: 3,
				fields: JSON.stringify({ name: 'Welcome', subject: 'Bob edited again' }),
			});
			await settle();
			expect(bridge.subject.value).toBe('Bob edited again');
			// The navigation the Save let go is retried: it asks about the new edit.
			expect(await leave()).toBe('blocked');
			unmount();
		});

		it('retries a failed Save of their edit as a Save', async () => {
			const { bridge, source, save, unmount } = await withTheirEdit();
			save.mockRejectedValueOnce(new Error('temporary refusal'));
			await bridge.requestSave();
			expect(bridge.autosave!.autosave.status.value).toBe('error');
			save.mockImplementationOnce(writesTheSession(source));
			bridge.autosave!.autosave.retry();
			await vi.advanceTimersByTimeAsync(0);
			expect(save).toHaveBeenCalledTimes(2);
			expect(bridge.autosave!.autosave.status.value).toBe('saved');
			unmount();
		});

		it('is written by the Save shortcut', async () => {
			const { bridge, source, save, unmount } = await withTheirEdit();
			save.mockImplementationOnce(writesTheSession(source));
			await bridge.requestSave();
			expect(save).toHaveBeenCalledOnce();
			expect(bridge.autosave!.autosave.status.value).toBe('saved');
			unmount();
		});
	});

	it('counts nothing as saved while its edits cannot reach the session, and does not publish', async () => {
		const { bridge, source, save, unmount } = await joined();
		mutation.mockImplementation(async (fn: string) => {
			if (fn === 'sessions.applyOps') throw new Error('offline');
			if (fn === 'presence.heartbeat') return { isLeaseHeld: false, heldBy: null };
			return null;
		});
		const publish = vi.fn(async (_args: unknown) => ({ ok: true }));
		vi.stubGlobal('useBackendOperation', () => ({ run: publish, isLoading: ref(false) }));
		const publication = useTemplatePublication({
			templateId: ref('t1' as never),
			template: computed(() => ({ ...source.value!, htmlContent: '<p>Stored</p>' })),
			hasChanges: bridge.hasChanges,
			draft: () => bridge.autosave!.autosave,
		});
		bridge.subject.value = 'Never reaches the session';
		await settle();
		const done = publication.togglePublication();
		// The bounded send rounds run out.
		await vi.advanceTimersByTimeAsync(60_000);
		await done;
		// The older shared session is not written in its place.
		expect(save).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
		const autosave = bridge.autosave!.autosave;
		expect(autosave.status.value).toBe('error');
		expect(autosave.atRisk.value).toBe(true);
		expect(bridge.subject.value).toBe('Never reaches the session');
		unmount();
	});

	it('does not count a save as done while the session never reports it written', async () => {
		const { bridge, save, unmount } = await joined();
		bridge.blocks.value = [text('a', 'Alpha edited')];
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		queries['sessions.get']!.value = sessionRow(2, 1);
		await settle();
		await vi.advanceTimersByTimeAsync(1500);
		expect(save).toHaveBeenCalledOnce();
		// `untilSaved` runs out without the session reporting version 2 saved.
		await vi.advanceTimersByTimeAsync(10_000);
		const autosave = bridge.autosave!.autosave;
		expect(autosave.status.value).toBe('error');
		expect(autosave.atRisk.value).toBe(true);
		unmount();
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
