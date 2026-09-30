/**
 * Send and promotion stand on an acknowledged save of the CURRENT snapshot
 * (#895).
 *
 * `drafts.send` takes only a draft id and reads the stored row, so a save that
 * failed before it means the message goes out as it was stored, not as it is
 * on screen: the old recipients, the old body. These run the real composer and
 * autosave against scripted `drafts.update` outcomes and check that a failed
 * save stops the send before `drafts.send` is ever called — no undo window, no
 * mirror retirement, the text still in the composer, and a notice saying so —
 * that a later successful save sends the latest fields, and that a dropped
 * connection hands the current composition to the offline outbox instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, ref, type Ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import { isSurfacedOperationError } from '~/lib/operationError';

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

const undoArm = vi.fn();
vi.mock('../usePostboxUndoSend', () => ({ usePostboxUndoSend: () => ({ arm: undoArm }) }));

/** The recovery mirror, down to the call that throws it away. */
const retire = vi.fn();
vi.mock('../usePostboxComposeMirror', () => ({
	usePostboxComposeMirror: () =>
		reactive({ restorable: ref(null), restore: () => {}, dismiss: () => {}, retire }),
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

/** What each `drafts.update` call answers, in order; 'ok' once the script runs out. */
type Outcome = 'ok' | 'reject' | 'network';
let updateOutcomes: Outcome[];
/** When set, `drafts.update` waits for it before answering (an in-flight save). */
let updateGate: Promise<void> | null;
/** Runs inside each `drafts.update` call: an edit made while the save is out. */
let duringUpdate: (() => void) | null;
let updateRun: ReturnType<typeof vi.fn>;
let sendRun: ReturnType<typeof vi.fn>;
let draftQuery: ReturnType<typeof queryResult<unknown>>;

const SAVED_ROW = {
	state: 'draft',
	toAddresses: ['old@example.com'],
	ccAddresses: [],
	bccAddresses: [],
	subject: 'Quarterly numbers',
	bodyHtml: '<p>Old body</p>',
	composerMode: 'simple',
	lastEditedAt: 100,
};

beforeEach(() => {
	vi.useFakeTimers();
	isOffline.value = false;
	updateOutcomes = [];
	updateGate = null;
	duringUpdate = null;
	undoArm.mockClear();
	retire.mockClear();
	queueSend.mockClear();
	draftQuery = queryResult<unknown>(SAVED_ROW);

	vi.stubGlobal('useConvexQuery', (fn: unknown) =>
		fn === 'drafts.get' ? draftQuery : queryResult(undefined)
	);
	vi.stubGlobal('useI18n', () => i18n.global);
	updateRun = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true }));
	sendRun = vi.fn(async (_args: Record<string, unknown>) => ({
		ok: true,
		result: { undoToken: 'tok', sendAt: 1 },
	}));
	vi.stubGlobal(
		'useBackendOperation',
		(fn: unknown, opts?: { onError?: (e: unknown) => boolean }) => {
			const fail = (outcome: Outcome) => {
				if (outcome === 'network') opts?.onError?.({ category: 'network', message: 'offline' });
				return { ok: false as const };
			};
			if (fn === 'drafts.update') {
				const run = vi.fn(async (args: Record<string, unknown>) => {
					updateRun(args);
					duringUpdate?.();
					if (updateGate) await updateGate;
					const outcome = updateOutcomes.shift() ?? 'ok';
					return outcome === 'ok' ? { ok: true, result: { savedAt: Date.now() } } : fail(outcome);
				});
				return { run, isLoading: ref(false) };
			}
			if (fn === 'drafts.send') return { run: sendRun, isLoading: ref(false) };
			if (fn === 'drafts.create') {
				return {
					run: vi.fn(async () => ({ ok: true, result: { draftId: 'draft-new' } })),
					isLoading: ref(false),
				};
			}
			return { run: vi.fn(async () => ({ ok: true, result: {} })), isLoading: ref(false) };
		}
	);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvex', () => null);
});

afterEach(() => {
	vi.useRealTimers();
});

/** Reopen the saved draft and let its row hydrate. */
async function reopenDraft() {
	const { usePostboxCompose } = await import('../usePostboxCompose');
	const composer = effectScope().run(() =>
		usePostboxCompose({ mailboxId: 'mbx-1' as never, draftId: 'draft-1' as never })
	)!;
	await nextTick();
	return composer;
}

/** The edit the stale row must never be sent in place of. */
async function editRecipientsAndBody(composer: Awaited<ReturnType<typeof reopenDraft>>) {
	composer.toAddresses.value = ['new@example.com'];
	composer.bodyHtml.value = '<p>New body</p>';
	await nextTick();
}

function lastUpdate(): Record<string, unknown> {
	return updateRun.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('usePostboxCompose — Send needs the current snapshot saved (#895)', () => {
	it('refuses to send after a failed debounced save that also fails on retry', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		updateOutcomes = ['reject', 'reject'];
		await vi.advanceTimersByTimeAsync(1500);
		expect(updateRun).toHaveBeenCalledOnce();

		const error = await composer.send().catch((e: unknown) => e);

		expect(isSurfacedOperationError(error)).toBe(true);
		// Send retried the save once, then stopped short of the send mutation.
		expect(updateRun).toHaveBeenCalledTimes(2);
		expect(sendRun).not.toHaveBeenCalled();
		expect(undoArm).not.toHaveBeenCalled();
		expect(retire).not.toHaveBeenCalled();
		expect(composer.toAddresses.value).toEqual(['new@example.com']);
		expect(composer.bodyHtml.value).toBe('<p>New body</p>');
		expect(composer.draftNotice.value).toBe('not_sent');
	});

	it('refuses to send when the final save at the Send boundary fails', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		updateOutcomes = ['reject'];

		// Sent inside the debounce window: send() writes the snapshot itself.
		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);

		expect(updateRun).toHaveBeenCalledOnce();
		expect(lastUpdate()).toMatchObject({ toAddresses: ['new@example.com'] });
		expect(sendRun).not.toHaveBeenCalled();
		expect(undoArm).not.toHaveBeenCalled();
		expect(retire).not.toHaveBeenCalled();
		expect(composer.draftNotice.value).toBe('not_sent');
	});

	it('sends the latest recipients and body once a retried save lands', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		updateOutcomes = ['reject'];
		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);

		composer.ccAddresses.value = ['cc@example.com'];
		composer.bodyHtml.value = '<p>Newest body</p>';
		await nextTick();
		const sent = await composer.send();

		expect(lastUpdate()).toMatchObject({
			draftId: 'draft-1',
			toAddresses: ['new@example.com'],
			ccAddresses: ['cc@example.com'],
			bodyHtml: '<p>Newest body</p>',
		});
		expect(sendRun).toHaveBeenCalledOnce();
		expect(sendRun.mock.calls[0]![0]).toMatchObject({ draftId: 'draft-1' });
		// The save preceded the send that reads it.
		expect(updateRun.mock.invocationCallOrder.at(-1)!).toBeLessThan(
			sendRun.mock.invocationCallOrder[0]!
		);
		expect(sent).toEqual({ undoToken: 'tok', sendAt: 1 });
		expect(undoArm).toHaveBeenCalledOnce();
		expect(retire).toHaveBeenCalledOnce();
		expect(composer.draftNotice.value).toBeNull();
	});

	it('writes again when the save in flight at Send carried an older snapshot', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		let release!: () => void;
		updateGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await vi.advanceTimersByTimeAsync(1500);
		expect(updateRun).toHaveBeenCalledOnce();

		composer.subject.value = 'Typed while the save was in flight';
		await nextTick();
		const sending = composer.send();
		updateGate = null;
		release();
		await sending;

		expect(updateRun).toHaveBeenCalledTimes(2);
		expect(lastUpdate()).toMatchObject({ subject: 'Typed while the save was in flight' });
		expect(sendRun).toHaveBeenCalledOnce();
	});

	it('refuses, not queues, when only the earlier in-flight save lost its connection', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		let release!: () => void;
		updateGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The debounced save drops on the transport; the Send retry is refused.
		updateOutcomes = ['network', 'reject'];
		await vi.advanceTimersByTimeAsync(1500);

		const sending = composer.send().catch((e: unknown) => e);
		updateGate = null;
		release();
		const error = await sending;

		expect(isSurfacedOperationError(error)).toBe(true);
		expect(updateRun).toHaveBeenCalledTimes(2);
		expect(queueSend).not.toHaveBeenCalled();
		expect(sendRun).not.toHaveBeenCalled();
		expect(undoArm).not.toHaveBeenCalled();
		expect(composer.draftNotice.value).toBe('not_sent');
	});

	it("saves again when the fields change while Send's own final save is out", async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		let release!: () => void;
		updateGate = new Promise<void>((resolve) => {
			release = resolve;
		});

		// Sent inside the debounce window, so Send's own write is the one held.
		const sending = composer.send();
		await vi.advanceTimersByTimeAsync(0);
		expect(updateRun).toHaveBeenCalledOnce();
		composer.toAddresses.value = ['later@example.com'];
		composer.bodyHtml.value = '<p>Edited during the save</p>';
		await nextTick();
		updateGate = null;
		release();
		await sending;

		expect(updateRun).toHaveBeenCalledTimes(2);
		expect(lastUpdate()).toMatchObject({
			toAddresses: ['later@example.com'],
			bodyHtml: '<p>Edited during the save</p>',
		});
		expect(sendRun).toHaveBeenCalledOnce();
		expect(updateRun.mock.invocationCallOrder.at(-1)!).toBeLessThan(
			sendRun.mock.invocationCallOrder[0]!
		);
	});

	it('refuses to send when the fields keep changing under every save', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		let edits = 0;
		duringUpdate = () => {
			edits += 1;
			composer.subject.value = `Still typing ${edits}`;
		};

		await expect(composer.send()).rejects.toSatisfy(isSurfacedOperationError);

		// Bounded: three writes, then a refusal rather than a stale send.
		expect(updateRun).toHaveBeenCalledTimes(3);
		expect(sendRun).not.toHaveBeenCalled();
		expect(undoArm).not.toHaveBeenCalled();
		expect(retire).not.toHaveBeenCalled();
		expect(composer.draftNotice.value).toBe('not_sent');
	});

	it('does not write again when the current snapshot is already saved', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		await vi.advanceTimersByTimeAsync(1500);
		expect(updateRun).toHaveBeenCalledOnce();

		await composer.send();

		expect(updateRun).toHaveBeenCalledOnce();
		expect(sendRun).toHaveBeenCalledOnce();
	});

	it('queues the current composition offline when the save loses its connection', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		updateOutcomes = ['network'];

		const sent = await composer.send();

		expect(sendRun).not.toHaveBeenCalled();
		expect(queueSend).toHaveBeenCalledOnce();
		expect(queueSend.mock.calls[0]![0]).toMatchObject({
			draftId: 'draft-1',
			toAddresses: ['new@example.com'],
			bodyHtml: '<p>New body</p>',
		});
		expect(sent).toEqual({ undoToken: 'outbox:ns:1', sendAt: 0 });
		expect(undoArm).toHaveBeenCalledOnce();
		// The outbox holds the complete text now; the mirror has nothing to guard.
		expect(retire).toHaveBeenCalledOnce();
	});
});

describe('usePostboxCompose — flush() reports whether it saved (#895)', () => {
	it('resolves ok:false and keeps the text when the save fails', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		updateOutcomes = ['reject'];

		const result = await composer.flush();

		expect(result).toEqual({ ok: false });
		expect(composer.draftNotice.value).toBe('not_saved');
		expect(composer.toAddresses.value).toEqual(['new@example.com']);
	});

	it('saves again when the fields change while its own save is out', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);
		let release!: () => void;
		updateGate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const flushing = composer.flush();
		await vi.advanceTimersByTimeAsync(0);
		composer.toAddresses.value = ['later@example.com'];
		await nextTick();
		updateGate = null;
		release();
		const result = await flushing;

		expect(result).toEqual({ ok: true, result: 'draft-1' });
		expect(updateRun).toHaveBeenCalledTimes(2);
		expect(lastUpdate()).toMatchObject({ toAddresses: ['later@example.com'] });
	});

	it('resolves the draft id once the current snapshot is saved', async () => {
		const composer = await reopenDraft();
		await editRecipientsAndBody(composer);

		const result = await composer.flush();

		expect(result).toEqual({ ok: true, result: 'draft-1' });
		expect(lastUpdate()).toMatchObject({ toAddresses: ['new@example.com'] });
	});

	it('keeps an inline reply inline when its flush did not save', async () => {
		const { usePostboxComposerInline } = await import('../usePostboxComposerInline');
		const emitPromote = vi.fn();
		const flush = vi.fn(async () => ({ ok: false as const }));
		const inline = effectScope().run(() =>
			usePostboxComposerInline({
				inline: false,
				flush,
				snapshot: () => ({
					toAddresses: [],
					ccAddresses: [],
					bccAddresses: [],
					subject: '',
					bodyHtml: '',
				}),
				emitPromote,
			})
		)!;

		await inline.handlePromote();

		expect(flush).toHaveBeenCalledOnce();
		expect(emitPromote).not.toHaveBeenCalled();
		expect((inline.promoting as Ref<boolean>).value).toBe(false);
	});
});
