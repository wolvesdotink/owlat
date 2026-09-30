/**
 * A reopened draft writes nothing until its row has loaded (#896).
 *
 * A reopened composer has the draft's id at once, but its fields start empty
 * and fill in when `drafts.get` answers. Autosave writes a COMPLETE snapshot,
 * and `drafts.update` stores explicit empty values, so a subject edit made
 * while the read was slow used to save `toAddresses: []` and `bodyHtml: ''`
 * over the stored draft 1.5s later.
 *
 * These run the real composer and hydration with `drafts.get` held back, and
 * check that nothing is written, sent or promoted before the row arrives; that
 * edits made meanwhile are merged over it field by field (a field the user
 * touched keeps the user's value, every other field takes the row's, and an
 * emptied field is an edit like any other); that a failed read never turns
 * into a write; and that a brand-new composition autosaves as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import { isSurfacedOperationError } from '~/lib/operationError';
import type { ComposerSeed } from '../usePostboxCompose';

const i18n = createTestI18n();

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			drafts: {
				get: 'drafts.get',
				create: 'drafts.create',
				update: 'drafts.update',
				setIdentity: 'drafts.setIdentity',
				discard: 'drafts.discard',
				send: 'drafts.send',
				cancelPendingSend: 'drafts.cancelPendingSend',
				cancelScheduledSend: 'drafts.cancelScheduledSend',
			},
			identities: { listSendAsIdentities: 'identities.listSendAs' },
			signatures: { list: 'signatures.list' },
			settings: { get: 'settings.get', update: 'settings.update' },
		},
	},
}));

vi.mock('../usePostboxComposeAttachments', () => ({
	usePostboxComposeAttachments: () => ({
		attachments: ref([]),
		uploads: ref([]),
		isUploading: ref(false),
		attachmentSizeMeter: ref(null),
		thumbUrlFor: () => '',
		addFiles: () => {},
		removeAttachment: () => {},
		cancelUpload: () => {},
		retryUpload: () => {},
		addInlineImage: () => {},
		removeInlineImage: () => {},
	}),
}));

vi.mock('../usePostboxUndoSend', () => ({ usePostboxUndoSend: () => ({ arm: () => {} }) }));

vi.mock('../usePostboxComposeMirror', () => ({
	usePostboxComposeMirror: () =>
		reactive({ restorable: ref(null), restore: () => {}, dismiss: () => {}, retire: () => {} }),
}));

const queueSend = vi.fn(async (_payload: Record<string, unknown>) => ({
	undoToken: 'outbox:ns:1',
	sendAt: 0,
}));
const isOffline = ref(false);
vi.mock('../usePostboxOfflineOutbox', () => ({
	usePostboxOfflineOutbox: () => ({ isOffline, queueSend }),
	isQueuedSendToken: (token: string) => token.startsWith('outbox:'),
	OFFLINE_QUEUE_UNDO_WINDOW_MS: 10_000,
}));

const BLOCKS = [{ id: 'b1', type: 'text', content: 'Designed' }];

/** The stored draft: every field set, so a blanked one is visible. */
const SAVED_ROW = {
	state: 'draft',
	toAddresses: ['ada@example.com'],
	ccAddresses: ['bob@example.com'],
	bccAddresses: ['audit@example.com'],
	subject: 'Quarterly numbers',
	bodyHtml: '<p>Saved body</p>',
	composerMode: 'simple',
	followUpRemindAt: 5_000,
	lastEditedAt: 100,
};

let draftQuery: ReturnType<typeof queryResult<unknown>>;
let updateRun: ReturnType<typeof vi.fn>;
let createRun: ReturnType<typeof vi.fn>;
let sendRun: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers();
	isOffline.value = false;
	queueSend.mockClear();
	// Held back: the first read has not answered yet.
	draftQuery = queryResult<unknown>(undefined);

	vi.stubGlobal('useConvexQuery', (fn: unknown) =>
		fn === 'drafts.get' ? draftQuery : queryResult(undefined)
	);
	vi.stubGlobal('useI18n', () => i18n.global);
	updateRun = vi.fn(async () => ({ ok: true, result: { savedAt: 200 } }));
	createRun = vi.fn(async () => ({ ok: true, result: { draftId: 'draft-new' } }));
	sendRun = vi.fn(async () => ({ ok: true, result: { undoToken: 'tok', sendAt: 1 } }));
	vi.stubGlobal('useBackendOperation', (fn: unknown) => {
		if (fn === 'drafts.update') return { run: updateRun, isLoading: ref(false) };
		if (fn === 'drafts.create') return { run: createRun, isLoading: ref(false) };
		if (fn === 'drafts.send') return { run: sendRun, isLoading: ref(false) };
		return { run: vi.fn(async () => ({ ok: true, result: {} })), isLoading: ref(false) };
	});
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvex', () => null);
});

afterEach(() => {
	vi.useRealTimers();
});

async function openComposer(seed: Partial<ComposerSeed> = { draftId: 'draft-1' as never }) {
	const { usePostboxCompose } = await import('../usePostboxCompose');
	const composer = effectScope().run(() =>
		usePostboxCompose({ mailboxId: 'mbx-1' as never, ...seed })
	)!;
	await nextTick();
	return composer;
}

/** Let the row arrive, then run out the autosave debounce. */
async function hydrate(row: Record<string, unknown> = SAVED_ROW) {
	draftQuery.data.value = row;
	await nextTick();
	await vi.advanceTimersByTimeAsync(1500);
}

function lastUpdate(): Record<string, unknown> {
	return updateRun.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('usePostboxCompose — nothing is written before the row loads (#896)', () => {
	it('never saves empty recipients or body over the row after a subject-only edit', async () => {
		const composer = await openComposer();
		composer.subject.value = 'Quarterly numbers (final)';
		await nextTick();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(updateRun).not.toHaveBeenCalled();

		await hydrate();

		// The row filled everything the user did not touch; the edit survived.
		expect(composer.toAddresses.value).toEqual(['ada@example.com']);
		expect(composer.bodyHtml.value).toBe('<p>Saved body</p>');
		expect(composer.subject.value).toBe('Quarterly numbers (final)');
		expect(updateRun).toHaveBeenCalledOnce();
		expect(lastUpdate()).toMatchObject({
			draftId: 'draft-1',
			subject: 'Quarterly numbers (final)',
			toAddresses: ['ada@example.com'],
			ccAddresses: ['bob@example.com'],
			bccAddresses: ['audit@example.com'],
			bodyHtml: '<p>Saved body</p>',
			followUpRemindAt: 5_000,
		});
	});

	it('refuses Send, the offline queue and promotion until the row has loaded', async () => {
		const composer = await openComposer();
		composer.toAddresses.value = ['new@example.com'];
		composer.subject.value = 'Hello';
		await nextTick();

		expect(composer.canSend.value).toBe(false);
		expect(composer.draftNotice.value).toBe('loading');
		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);
		isOffline.value = true;
		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);
		isOffline.value = false;
		expect(await composer.flush()).toEqual({ ok: false });

		expect(updateRun).not.toHaveBeenCalled();
		expect(sendRun).not.toHaveBeenCalled();
		expect(queueSend).not.toHaveBeenCalled();

		await hydrate();
		expect(composer.canSend.value).toBe(true);
		expect(composer.draftNotice.value).toBeNull();
	});

	it('withholds the body editor until the saved body arrives, unless the seed brought it', async () => {
		const reopened = await openComposer();
		expect(reopened.bodyPending.value).toBe(true);
		await hydrate();
		expect(reopened.bodyPending.value).toBe(false);

		const promoted = await openComposer({
			draftId: 'draft-2' as never,
			prefillBodyHtml: '<p>Live body</p>',
		});
		expect(promoted.bodyPending.value).toBe(false);
	});

	it('still lets an offline-undo seed, which carries the whole composition, queue again', async () => {
		isOffline.value = true;
		const composer = await openComposer({
			draftId: 'draft-1' as never,
			prefillTo: ['new@example.com'],
			prefillCc: [],
			prefillBcc: [],
			prefillSubject: 'Hello',
			prefillBodyHtml: '<p>Queued body</p>',
		});

		expect(composer.canSend.value).toBe(true);
		await composer.send();

		expect(queueSend).toHaveBeenCalledOnce();
		expect(queueSend.mock.calls[0]![0]).toMatchObject({
			toAddresses: ['new@example.com'],
			bodyHtml: '<p>Queued body</p>',
		});
		expect(updateRun).not.toHaveBeenCalled();
	});
});

describe('usePostboxCompose — early edits merge over the loaded row (#896)', () => {
	it('keeps touched recipients and fills the untouched ones from the row', async () => {
		const composer = await openComposer();
		composer.toAddresses.value = ['new@example.com'];
		await nextTick();
		await hydrate();

		expect(lastUpdate()).toMatchObject({
			toAddresses: ['new@example.com'],
			ccAddresses: ['bob@example.com'],
			bccAddresses: ['audit@example.com'],
			bodyHtml: '<p>Saved body</p>',
		});
	});

	it('keeps seeded HTML over the row, and the row mode, since the seed typed nothing', async () => {
		const composer = await openComposer({
			draftId: 'draft-1' as never,
			prefillBodyHtml: '<p>Live body</p>',
		});
		await hydrate({ ...SAVED_ROW, composerMode: 'full', bodyBlocks: JSON.stringify(BLOCKS) });

		expect(composer.bodyHtml.value).toBe('<p>Live body</p>');
		expect(composer.composerMode.value).toBe('full');
		expect(composer.bodyBlocks.value).toEqual(BLOCKS);
		expect(lastUpdate()).toMatchObject({ bodyHtml: '<p>Live body</p>', composerMode: 'full' });
	});

	it('keeps an HTML edit in the mode it was typed in and the row blocks one switch away', async () => {
		const composer = await openComposer({
			draftId: 'draft-1' as never,
			prefillBodyHtml: '<p>Live body</p>',
		});
		composer.bodyHtml.value = '<p>Live body, edited</p>';
		await nextTick();
		await hydrate({ ...SAVED_ROW, composerMode: 'full', bodyBlocks: JSON.stringify(BLOCKS) });

		expect(composer.composerMode.value).toBe('simple');
		expect(composer.bodyBlocks.value).toEqual(BLOCKS);
		const saved = lastUpdate();
		expect(saved).toMatchObject({ bodyHtml: '<p>Live body, edited</p>', composerMode: 'simple' });
		// A simple-mode save leaves the stored blocks alone.
		expect(saved['bodyBlocks']).toBeUndefined();
	});

	it('keeps touched block content and composer mode', async () => {
		const composer = await openComposer();
		composer.composerMode.value = 'full';
		composer.bodyBlocks.value = BLOCKS as never;
		await nextTick();
		await hydrate({ ...SAVED_ROW, bodyBlocks: JSON.stringify([{ id: 'old' }]) });

		expect(composer.composerMode.value).toBe('full');
		expect(composer.bodyBlocks.value).toEqual(BLOCKS);
		expect(lastUpdate()).toMatchObject({
			composerMode: 'full',
			bodyBlocks: JSON.stringify(BLOCKS),
			bodyHtml: '<p>Saved body</p>',
		});
	});

	it('takes the row mode and blocks when neither was touched', async () => {
		const composer = await openComposer();
		composer.subject.value = 'New subject';
		await nextTick();
		await hydrate({ ...SAVED_ROW, composerMode: 'full', bodyBlocks: JSON.stringify(BLOCKS) });

		expect(lastUpdate()).toMatchObject({
			subject: 'New subject',
			composerMode: 'full',
			bodyBlocks: JSON.stringify(BLOCKS),
		});
	});

	it('keeps a follow-up reminder set before the load, and one cleared before the load', async () => {
		const setEarly = await openComposer();
		setEarly.followUpRemindAt.value = 9_000;
		await nextTick();
		await hydrate();
		expect(lastUpdate()).toMatchObject({ followUpRemindAt: 9_000 });

		updateRun.mockClear();
		draftQuery = queryResult<unknown>(undefined);
		const clearedEarly = await openComposer();
		clearedEarly.followUpRemindAt.value = 9_000;
		await nextTick();
		clearedEarly.followUpRemindAt.value = null;
		await nextTick();
		await hydrate();
		// Emptied is an edit, not "untouched": the row's 5_000 does not return.
		expect(clearedEarly.followUpRemindAt.value).toBeNull();
		expect(lastUpdate()).toMatchObject({ followUpRemindAt: null });
	});

	it('saves an intentional clear made after the row loaded', async () => {
		const composer = await openComposer();
		await hydrate();
		updateRun.mockClear();

		composer.ccAddresses.value = [];
		composer.subject.value = '';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(updateRun).toHaveBeenCalledOnce();
		expect(lastUpdate()).toMatchObject({
			ccAddresses: [],
			subject: '',
			toAddresses: ['ada@example.com'],
		});
	});
});

describe('usePostboxCompose — a failed first read never becomes a write (#896)', () => {
	it('shows the failure, writes nothing, and merges early edits once a retry loads', async () => {
		const composer = await openComposer();
		draftQuery.error.value = new Error('Server Error');
		await nextTick();
		composer.subject.value = 'Edited while the read failed';
		await nextTick();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(composer.draftNotice.value).toBe('load_failed');
		expect(composer.canSend.value).toBe(false);
		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);
		expect(updateRun).not.toHaveBeenCalled();
		expect(sendRun).not.toHaveBeenCalled();

		composer.retryLoad();
		expect(draftQuery.refetch).toHaveBeenCalledOnce();
		draftQuery.error.value = null;
		await hydrate();

		expect(composer.subject.value).toBe('Edited while the read failed');
		expect(lastUpdate()).toMatchObject({
			subject: 'Edited while the read failed',
			toAddresses: ['ada@example.com'],
			bodyHtml: '<p>Saved body</p>',
		});
	});
});

describe('usePostboxCompose — a draft that no longer exists (#896)', () => {
	it('turns a lasting "no such row" answer into the missing state and writes nothing', async () => {
		const composer = await openComposer();
		draftQuery.data.value = null;
		await nextTick();
		composer.subject.value = 'Edited after the draft was deleted';
		await nextTick();

		// Inside the grace a null may still be the pre-auth answer.
		await vi.advanceTimersByTimeAsync(500);
		expect(composer.draftNotice.value).toBe('loading');

		await vi.advanceTimersByTimeAsync(1_000);
		expect(composer.draftNotice.value).toBe('missing');
		expect(composer.canSend.value).toBe(false);
		expect(composer.bodyPending.value).toBe(true);
		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);
		expect(await composer.flush()).toEqual({ ok: false });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(updateRun).not.toHaveBeenCalled();
		expect(sendRun).not.toHaveBeenCalled();
	});

	it('does not queue a seeded composition offline once the draft is missing', async () => {
		const composer = await openComposer({
			draftId: 'draft-1' as never,
			prefillTo: ['new@example.com'],
			prefillCc: [],
			prefillBcc: [],
			prefillSubject: 'Hello',
			prefillBodyHtml: '<p>Queued body</p>',
		});
		draftQuery.data.value = null;
		await nextTick();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(composer.draftNotice.value).toBe('missing');
		isOffline.value = true;

		expect(composer.canSend.value).toBe(false);
		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);
		expect(queueSend).not.toHaveBeenCalled();
	});

	it('merges a row that follows a brief null, without ever calling the draft missing', async () => {
		const composer = await openComposer();
		draftQuery.data.value = null;
		await nextTick();
		await vi.advanceTimersByTimeAsync(300);
		await hydrate();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(composer.draftNotice.value).toBeNull();
		expect(composer.toAddresses.value).toEqual(['ada@example.com']);
	});

	it('still merges a row that arrives after the draft was called missing', async () => {
		const composer = await openComposer();
		composer.subject.value = 'Kept';
		draftQuery.data.value = null;
		await nextTick();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(composer.draftNotice.value).toBe('missing');

		await hydrate();

		expect(composer.draftNotice.value).toBeNull();
		expect(lastUpdate()).toMatchObject({ subject: 'Kept', toAddresses: ['ada@example.com'] });
	});
});

describe('usePostboxCompose — the row merges once', () => {
	it('ignores later live updates of the row, so edits after the load survive', async () => {
		const composer = await openComposer();
		await hydrate();
		composer.subject.value = 'Mine';
		composer.toAddresses.value = ['mine@example.com'];
		await nextTick();

		draftQuery.data.value = {
			...SAVED_ROW,
			subject: 'From another tab',
			toAddresses: ['other@example.com'],
			lastEditedAt: 300,
		};
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(composer.subject.value).toBe('Mine');
		expect(composer.toAddresses.value).toEqual(['mine@example.com']);
		expect(lastUpdate()).toMatchObject({ subject: 'Mine', toAddresses: ['mine@example.com'] });
	});
});

describe('usePostboxCompose — a new composition autosaves as before', () => {
	it('creates the row and saves the fields after the debounce', async () => {
		const composer = await openComposer({});
		expect(composer.draftNotice.value).toBeNull();
		expect(composer.bodyPending.value).toBe(false);

		composer.toAddresses.value = ['new@example.com'];
		composer.subject.value = 'Hello';
		composer.bodyHtml.value = '<p>Hi</p>';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(createRun).toHaveBeenCalledOnce();
		expect(updateRun).toHaveBeenCalledOnce();
		expect(lastUpdate()).toMatchObject({
			draftId: 'draft-new',
			toAddresses: ['new@example.com'],
			subject: 'Hello',
			bodyHtml: '<p>Hi</p>',
		});
	});
});
