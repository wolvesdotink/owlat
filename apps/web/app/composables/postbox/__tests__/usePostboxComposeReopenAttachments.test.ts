// @vitest-environment happy-dom
/**
 * #1272: a reopened draft's own attachments, when the person attaches a file
 * before `drafts.get` has answered.
 *
 * The merge of the first answer keeps a non-empty attachment list as it is, so
 * a file added while the row loaded used to be the only chip: the row's own
 * files stayed hidden, yet the send (built from the row) still carried them.
 * The chips follow the row once it is merged (usePostboxComposeExpected), so
 * the row's files join the one added meanwhile, and an upload that lands after
 * the row already showed it is not added twice (`onCommitted`).
 *
 * An inline body image is on the row too, but it renders in the body: neither
 * hydration nor the row-follow shows it as a file chip, so a reopen no longer
 * offers a chip whose removal would break the body. It stays on the row, and
 * the send (built from the row) still carries it.
 *
 * These run the real composer, hydration, attachment and row-follow code
 * against a small in-memory row; only the upload's XHR is replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import { isInlineImageReferenced, rewriteInlineImageCids } from '@owlat/shared/inlineImages';
import type * as Uploads from '../postboxAttachmentUploads';
import type { ComposerSeed } from '../usePostboxCompose';

const i18n = createTestI18n();

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
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
				addAttachment: 'drafts.addAttachment',
				removeAttachment: 'drafts.removeAttachment',
			},
			draftExpectedAttachments: { remove: 'expected.remove' },
			draftExpectedAttachmentsFulfil: { fulfil: 'expected.fulfil' },
			attachmentSharesActions: { shareDraftAttachment: 'shares.shareDraftAttachment' },
			identities: { listSendAsIdentities: 'identities.listSendAs' },
			signatures: { list: 'signatures.list' },
			settings: { get: 'settings.get', update: 'settings.update' },
		},
	},
}));

// The real upload state machine; the bytes are stored at once under a name-derived id.
vi.mock('../postboxAttachmentUploads', async (importActual) => ({
	...(await importActual<typeof Uploads>()),
	xhrPutFile: vi.fn(async (_url: string, file: File) => `storage_${file.name}`),
}));

vi.mock('../usePostboxUndoSend', () => ({ usePostboxUndoSend: () => ({ arm: () => {} }) }));
vi.mock('../usePostboxComposeMirror', () => ({
	usePostboxComposeMirror: () =>
		reactive({ restorable: ref(null), restore: () => {}, dismiss: () => {}, retire: () => {} }),
}));
vi.mock('../usePostboxOfflineOutbox', () => ({
	usePostboxOfflineOutbox: () => ({ isOffline: ref(false), queueSend: vi.fn() }),
	isQueuedSendToken: () => false,
	OFFLINE_QUEUE_UNDO_WINDOW_MS: 10_000,
}));

interface RowAttachment {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
	isInline?: boolean;
	contentId?: string;
}

const CONTRACT: RowAttachment = {
	storageId: 'storage_contract.pdf',
	filename: 'contract.pdf',
	contentType: 'application/pdf',
	size: 4_000,
};
const SCHEDULE: RowAttachment = {
	storageId: 'storage_schedule.xlsx',
	filename: 'schedule.xlsx',
	contentType: 'application/vnd.ms-excel',
	size: 2_000,
};
const LOGO: RowAttachment = {
	storageId: 'storage_logo.png',
	filename: 'logo.png',
	contentType: 'image/png',
	size: 500,
	isInline: true,
	contentId: 'logo@owlat.inline',
};
/** A body showing LOGO the way the Simple editor stores an embedded image. */
const LOGO_BODY =
	'<p>Attached.</p><p><img src="blob:http://localhost/preview" data-inline-cid="logo@owlat.inline"></p>';

/** The stored draft as the server holds it. */
let row: {
	state: 'draft';
	toAddresses: string[];
	subject: string;
	bodyHtml: string;
	composerMode: 'simple';
	lastEditedAt: number;
	attachments: RowAttachment[];
};
let draftQuery: ReturnType<typeof queryResult<unknown>>;
/** Whether `drafts.get` has answered yet; until then it stays undefined. */
let rowAnswered: boolean;
/** When set, `drafts.addAttachment` waits here until the test releases it. */
let holdAttach: boolean;
let releaseAttach: () => void;
let removeAttachment: ReturnType<typeof vi.fn>;
/** The row when `drafts.send` was called: the server builds the message from it. */
let sentRow: { bodyHtml: string; attachments: RowAttachment[] } | null;

/** A Convex query update: the subscription sees the row before any mutation resolves. */
function publish() {
	if (rowAnswered) draftQuery.data.value = JSON.parse(JSON.stringify(row));
}

beforeEach(() => {
	row = {
		state: 'draft',
		toAddresses: ['ada@example.com'],
		subject: 'Signed contract',
		bodyHtml: '<p>Attached.</p>',
		composerMode: 'simple',
		lastEditedAt: 100,
		attachments: [CONTRACT, SCHEDULE],
	};
	rowAnswered = false;
	holdAttach = false;
	sentRow = null;
	draftQuery = queryResult<unknown>(undefined);

	const addAttachment = (args: RowAttachment) => {
		const commit = () => {
			row.attachments = [
				...row.attachments,
				{
					storageId: args.storageId,
					filename: args.filename,
					contentType: args.contentType,
					size: args.size,
				},
			];
			publish();
			return { ok: true, result: { ok: true } };
		};
		if (!holdAttach) return Promise.resolve(commit());
		return new Promise((resolve) => {
			releaseAttach = () => resolve(commit());
		});
	};
	removeAttachment = vi.fn(async (args: { storageId: string }) => {
		row.attachments = row.attachments.filter((a) => a.storageId !== args.storageId);
		publish();
		return { ok: true, result: { ok: true } };
	});
	const ops: Record<string, (args: never) => Promise<unknown>> = {
		'storage.generateUploadUrl': async () => ({ ok: true, result: 'https://upload.example' }),
		'drafts.addAttachment': addAttachment as never,
		'drafts.removeAttachment': removeAttachment as never,
		'drafts.update': async (args: { bodyHtml?: string }) => {
			if (typeof args.bodyHtml === 'string') row.bodyHtml = args.bodyHtml;
			return { ok: true, result: { savedAt: 200 } };
		},
		'drafts.send': async () => {
			sentRow = JSON.parse(
				JSON.stringify({ bodyHtml: row.bodyHtml, attachments: row.attachments })
			);
			return { ok: true, result: { undoToken: 'tok', sendAt: 1 } };
		},
	};
	vi.stubGlobal('useBackendOperation', (name: string) => ({
		run: ops[name] ?? vi.fn(async () => ({ ok: true, result: {} })),
		isLoading: ref(false),
	}));
	// Every `drafts.get` subscription in the composer shares the one answer.
	vi.stubGlobal('useConvexQuery', (fn: unknown) =>
		fn === 'drafts.get' ? draftQuery : queryResult(undefined)
	);
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useConvex', () => null);
});

const flush = async () => {
	for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

async function reopen(seed: Partial<ComposerSeed> = {}) {
	const { usePostboxCompose } = await import('../usePostboxCompose');
	const composer = withSetup(() =>
		usePostboxCompose({ mailboxId: 'mbx-1' as never, draftId: 'draft-1' as never, ...seed })
	).result;
	await flush();
	return composer;
}

/** `drafts.get` answers with the row as it is now. */
async function rowLoads() {
	rowAnswered = true;
	publish();
	await flush();
}

const shown = (composer: Awaited<ReturnType<typeof reopen>>) =>
	composer.attachments.value.map((a) => a.filename).sort();

/**
 * The parts the message carries: the pick `bufferDraftAttachments`
 * (`mail/outbound/build.ts`) makes from the row, through the same shared
 * helpers. Files always go; an inline image only while the body shows it. The
 * web app cannot import `apps/api`; `outboundInlineParts.test.ts` there runs
 * the real function on this row.
 */
function outboundParts(sent: NonNullable<typeof sentRow>): string[] {
	const { referencedCids } = rewriteInlineImageCids(sent.bodyHtml);
	return sent.attachments
		.filter((a) => !a.isInline || isInlineImageReferenced(referencedCids, a.contentId))
		.map((a) => a.filename);
}

const notes = () => new File(['notes'], 'notes.txt', { type: 'text/plain' });

describe('usePostboxCompose: a reopened draft shows its own attachments (#1272)', () => {
	it('shows the row’s files beside one attached before the row loaded, each once', async () => {
		const composer = await reopen();
		expect(composer.draftNotice.value).toBe('loading');

		await composer.addFiles([notes()]);
		await flush();
		// Committed to the row; the composer has not heard from the row yet.
		expect(row.attachments.map((a) => a.filename)).toEqual([
			'contract.pdf',
			'schedule.xlsx',
			'notes.txt',
		]);
		expect(shown(composer)).toEqual(['notes.txt']);

		await rowLoads();

		expect(composer.draftNotice.value).toBeNull();
		expect(shown(composer)).toEqual(['contract.pdf', 'notes.txt', 'schedule.xlsx']);
		expect(composer.uploads.value).toEqual([]);
		// The meter and limits count what the send will carry.
		expect(composer.attachmentSizeMeter.value.totalBytes).toBe(
			CONTRACT.size + SCHEDULE.size + 'notes'.length
		);
	});

	it('does the same when the first read failed and the person kept working before retrying', async () => {
		const composer = await reopen();
		draftQuery.error.value = new Error('offline') as never;
		await flush();
		expect(composer.draftNotice.value).toBe('load_failed');

		await composer.addFiles([notes()]);
		await flush();
		expect(shown(composer)).toEqual(['notes.txt']);

		// "Try again" answers.
		draftQuery.error.value = null;
		await rowLoads();

		expect(composer.draftNotice.value).toBeNull();
		expect(shown(composer)).toEqual(['contract.pdf', 'notes.txt', 'schedule.xlsx']);
	});

	it('lets the person remove the row’s own files, and they stay removed', async () => {
		const composer = await reopen();
		await composer.addFiles([notes()]);
		await flush();
		await rowLoads();

		await composer.removeAttachment(CONTRACT.storageId);
		await flush();
		expect(removeAttachment).toHaveBeenCalledWith({
			draftId: 'draft-1',
			storageId: CONTRACT.storageId,
		});
		expect(shown(composer)).toEqual(['notes.txt', 'schedule.xlsx']);

		await composer.removeAttachment(SCHEDULE.storageId);
		await flush();
		expect(shown(composer)).toEqual(['notes.txt']);
		expect(row.attachments.map((a) => a.filename)).toEqual(['notes.txt']);
	});

	it('keeps an upload still attaching when the row loads, and shows it once it lands', async () => {
		holdAttach = true;
		const composer = await reopen();
		await composer.addFiles([notes()]);
		await flush();
		expect(composer.uploads.value.map((c) => c.filename)).toEqual(['notes.txt']);

		await rowLoads();
		expect(shown(composer)).toEqual(['contract.pdf', 'schedule.xlsx']);
		expect(composer.uploads.value.map((c) => c.filename)).toEqual(['notes.txt']);
		expect(composer.isUploading.value).toBe(true);

		releaseAttach();
		await flush();
		expect(shown(composer)).toEqual(['contract.pdf', 'notes.txt', 'schedule.xlsx']);
		expect(composer.uploads.value).toEqual([]);
		expect(composer.isUploading.value).toBe(false);
	});

	it('leaves an inline body image out of the chips when a file was attached meanwhile', async () => {
		row.attachments = [CONTRACT, LOGO];
		const composer = await reopen();
		await composer.addFiles([notes()]);
		await flush();
		await rowLoads();

		expect(shown(composer)).toEqual(['contract.pdf', 'notes.txt']);
	});
});

describe('usePostboxCompose: a reopened draft never shows an inline body image as a chip', () => {
	it('shows no chip for a draft whose only part is an inline image', async () => {
		row.attachments = [LOGO];
		const composer = await reopen();
		await rowLoads();

		expect(composer.draftNotice.value).toBeNull();
		expect(composer.attachments.value).toEqual([]);
		expect(composer.attachmentSizeMeter.value.totalBytes).toBe(0);
	});

	it('shows the files beside an inline image, and removing one leaves the image alone', async () => {
		row.attachments = [CONTRACT, LOGO, SCHEDULE];
		const composer = await reopen();
		await rowLoads();
		expect(shown(composer)).toEqual(['contract.pdf', 'schedule.xlsx']);

		await composer.removeAttachment(CONTRACT.storageId);
		await flush();

		expect(removeAttachment).toHaveBeenCalledOnce();
		expect(removeAttachment).toHaveBeenCalledWith({
			draftId: 'draft-1',
			storageId: CONTRACT.storageId,
		});
		expect(shown(composer)).toEqual(['schedule.xlsx']);
		expect(row.attachments).toEqual([LOGO, SCHEDULE]);
	});

	it('still sends the inline image: the row keeps it and the body still shows it', async () => {
		row.bodyHtml = LOGO_BODY;
		row.attachments = [CONTRACT, LOGO];
		const composer = await reopen();
		await rowLoads();
		expect(shown(composer)).toEqual(['contract.pdf']);

		await composer.send();

		expect(sentRow).not.toBeNull();
		expect(sentRow!.attachments).toEqual([CONTRACT, LOGO]);
		expect(outboundParts(sentRow!)).toEqual(['contract.pdf', 'logo.png']);
	});

	it('holds Send for a draft whose only content is an inline image, as a new one does', async () => {
		row.subject = '';
		row.bodyHtml =
			'<p><img src="blob:http://localhost/preview" data-inline-cid="logo@owlat.inline"></p>';
		row.attachments = [LOGO];
		const composer = await reopen();
		await rowLoads();

		expect(composer.draftNotice.value).toBeNull();
		expect(composer.attachments.value).toEqual([]);
		expect(composer.canSend.value).toBe(false);
	});

	it('leaves the inline image out of the list hydration fills, before the chips follow the row', async () => {
		const { usePostboxComposeHydration } = await import('../usePostboxComposeHydration');
		const attachments = ref<Array<{ storageId: string }>>([]);
		const field = <T>(value: T) => ref(value) as never;
		withSetup(() =>
			usePostboxComposeHydration(
				ref('draft-1' as never),
				{
					toAddresses: field([]),
					ccAddresses: field([]),
					bccAddresses: field([]),
					subject: field(''),
					bodyHtml: field(''),
					bodyBlocks: field([]),
					fromAddress: field(''),
					composerMode: field('simple'),
					draftState: field('draft'),
					scheduledSendAt: field(null),
					followUpRemindAt: field(null),
					attachments: attachments as never,
					lastSavedAt: field(null),
					isGapGuarded: field(false),
				},
				{
					state: ref('loading'),
					touched: { isTouched: () => false, applying: (fn: () => void) => fn() } as never,
					shouldMerge: () => true,
					latestRow: ref({ status: 'unknown' }),
				}
			)
		);
		row.attachments = [CONTRACT, LOGO];
		await rowLoads();

		expect(attachments.value.map((a) => a.storageId)).toEqual([CONTRACT.storageId]);
	});

	it('drops an inline image an earlier offline-queued send carried as a chip', async () => {
		// A payload queued before inline parts were left out of the chips.
		const { isInline: _isInline, contentId: _contentId, ...logoChip } = LOGO;
		row.attachments = [CONTRACT, LOGO];
		const composer = await reopen({ prefillAttachments: [CONTRACT, logoChip] });
		await rowLoads();

		expect(shown(composer)).toEqual(['contract.pdf']);
		expect(row.attachments).toEqual([CONTRACT, LOGO]);
	});
});
