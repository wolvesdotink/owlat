/**
 * A send that goes to the offline outbox retires the draft mirror (plan idea 7).
 *
 * The mirror exists to hold keystrokes the server has not been told about. Once
 * the outbox owns a COMPLETE copy of the composition, that job is over — and
 * leaving the mirror behind is worse than useless: a fresh compose mirrors
 * under a shared provisional key ('new', or 'new-reply:<id>'), so the next blank
 * compose would reconcile that key and offer "Restore unsaved changes" holding a
 * message that is already queued. Accepting it puts the same mail one click from
 * being sent twice.
 *
 * All three ways a send ends up offline are covered: no connection at all, the
 * draft row's create failing on the transport, and `drafts.send` itself failing
 * on the transport. Plus the negative: a queue that THROWS (the device could not
 * store the payload) leaves the mirror alone, because the only copy of that
 * message is still the one in the composer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, reactive } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';

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

/** The mirror, stubbed down to the one call this file is about. */
const retire = vi.fn();
vi.mock('../usePostboxComposeMirror', () => ({
	usePostboxComposeMirror: () =>
		reactive({ restorable: ref(null), restore: () => {}, dismiss: () => {}, retire }),
}));

const queueSend = vi.fn(async () => ({ undoToken: 'outbox:ns:1', sendAt: 0 }));
const isOffline = ref(false);
vi.mock('../usePostboxOfflineOutbox', () => ({
	usePostboxOfflineOutbox: () => ({ isOffline, queueSend }),
	isQueuedSendToken: (token: string) => token.startsWith('outbox:'),
	OFFLINE_QUEUE_UNDO_WINDOW_MS: 30_000,
}));

/** Which mutation drops its connection mid-send, if any. */
let transportFails: 'create' | 'send' | null;

beforeEach(() => {
	isOffline.value = false;
	transportFails = null;
	retire.mockClear();
	queueSend.mockClear();
	queueSend.mockImplementation(async () => ({ undoToken: 'outbox:ns:1', sendAt: 0 }));

	vi.stubGlobal('useConvexQuery', () => queryResult(undefined));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal(
		'useBackendOperation',
		(fn: unknown, opts?: { onError?: (e: unknown) => boolean }) => {
			// The composable claims a transport failure through `onError` and turns
			// it into an enqueue; every operation gets that hook, exactly as in app.
			const fail = () => {
				opts?.onError?.({ category: 'network', message: 'offline' });
				return { ok: false as const };
			};
			const run = vi.fn(async () => {
				if (fn === 'drafts.create') {
					return transportFails === 'create' ? fail() : { ok: true, result: { draftId: 'd1' } };
				}
				if (fn === 'drafts.send') {
					return transportFails === 'send'
						? fail()
						: { ok: true, result: { undoToken: 'tok', sendAt: 1 } };
				}
				return { ok: true, result: { savedAt: 1 } };
			});
			return { run, isLoading: ref(false) };
		}
	);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvex', () => null);
});

async function makeComposer() {
	const { usePostboxCompose } = await import('../usePostboxCompose');
	const composer = usePostboxCompose({ mailboxId: 'mbx-1' as never });
	composer.toAddresses.value = ['ines@northwind.studio'];
	composer.subject.value = 'Invoice 4471';
	return composer;
}

describe('usePostboxCompose — the offline send retires the mirror', () => {
	it('retires it when the send is queued with no connection at all', async () => {
		isOffline.value = true;
		const composer = await makeComposer();
		await composer.send();
		expect(queueSend).toHaveBeenCalledOnce();
		expect(retire).toHaveBeenCalledOnce();
	});

	it('retires it when the draft row could not be created on the transport', async () => {
		transportFails = 'create';
		const composer = await makeComposer();
		await composer.send();
		expect(queueSend).toHaveBeenCalledOnce();
		expect(retire).toHaveBeenCalledOnce();
	});

	it('retires it when the send mutation itself fails on the transport', async () => {
		transportFails = 'send';
		const composer = await makeComposer();
		await composer.send();
		expect(queueSend).toHaveBeenCalledOnce();
		expect(retire).toHaveBeenCalledOnce();
	});

	it('still retires it on a normal online send', async () => {
		const composer = await makeComposer();
		await composer.send();
		expect(queueSend).not.toHaveBeenCalled();
		expect(retire).toHaveBeenCalledOnce();
	});

	it('keeps the mirror when the device could not store the queued payload', async () => {
		isOffline.value = true;
		queueSend.mockImplementation(async () => {
			throw new Error('QuotaExceededError');
		});
		const composer = await makeComposer();
		await expect(composer.send()).rejects.toThrow();
		// The composer still holds the only copy of this message.
		expect(retire).not.toHaveBeenCalled();
	});
});
