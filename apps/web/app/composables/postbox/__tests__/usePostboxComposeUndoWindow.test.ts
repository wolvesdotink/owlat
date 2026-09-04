/**
 * Undo-send window reaching the wire (plan idea 8).
 *
 * The backend has accepted `undoSendDelayMs` on `mail.drafts.send` all along;
 * the composer never passed it, so everyone lived with the server's 30s. These
 * tests pin the three things that make the preference safe to add:
 *
 *   - an UNSET preference sends no `undoSendDelayMs` at all — a user who never
 *     opens the setting produces the exact mutation args the composer produced
 *     before it existed, and the server keeps owning the default;
 *   - a chosen window (10 / 60) travels in milliseconds, and 'Off' travels as an
 *     explicit `0` rather than being omitted (omitting it would silently mean
 *     30s — the opposite of what the sender asked for); and
 *   - the OFFLINE payload's `sendOptions` never gains the window: the reconnect
 *     drain replays those options verbatim and deliberately dispatches a drained
 *     item immediately, so baking the hold in there would re-arm it after
 *     reconnect with no toast left to cancel it. The window reaches the queued
 *     send's `sendAt` (which only bounds the toast) by a separate path.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

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

/** Stand-in for the offline outbox so the offline branch is observable. */
const queueSend = vi.fn(async () => ({ undoToken: 'outbox:ns:1', sendAt: 0 }));
const isOffline = ref(false);
vi.mock('../usePostboxOfflineOutbox', () => ({
	usePostboxOfflineOutbox: () => ({ isOffline, queueSend }),
	isQueuedSendToken: (token: string) => token.startsWith('outbox:'),
	OFFLINE_QUEUE_UNDO_WINDOW_MS: 30_000,
}));

/** The saved `mailUserSettings` row the settings query answers with. */
let settingsData: Ref<{ undoSendSeconds?: number } | null>;
let sendRun: Mock;

beforeEach(() => {
	settingsData = ref(null);
	isOffline.value = false;
	queueSend.mockClear();

	vi.stubGlobal('useConvexQuery', (fn: unknown) => {
		if (fn === 'settings.get') return { data: settingsData, isLoading: ref(false) };
		return { data: ref(undefined), isLoading: ref(false) };
	});
	sendRun = vi.fn(async () => ({ ok: true, result: { undoToken: 'tok', sendAt: 1 } }));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useBackendOperation', (fn: unknown) => {
		if (fn === 'drafts.send') return { run: sendRun, isLoading: ref(false) };
		if (fn === 'drafts.create')
			return {
				run: vi.fn(async () => ({ ok: true, result: { draftId: 'draft-new' } })),
				isLoading: ref(false),
			};
		return { run: vi.fn(async () => ({ ok: true, result: {} })), isLoading: ref(false) };
	});
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvex', () => null);
});

async function makeComposer() {
	const { usePostboxCompose } = await import('../usePostboxCompose');
	const composer = effectScope().run(() => usePostboxCompose({ mailboxId: 'mbx-1' as never }))!;
	composer.toAddresses.value = ['someone@example.com'];
	composer.subject.value = 'Hello';
	return composer;
}

function sentDelay(): unknown {
	return (sendRun.mock.calls[0]?.[0] as { undoSendDelayMs?: number }).undoSendDelayMs;
}

describe('usePostboxCompose — undo-send window on the wire', () => {
	it('sends no undoSendDelayMs when the preference was never set', async () => {
		const composer = await makeComposer();
		await composer.send();
		expect(sendRun).toHaveBeenCalledOnce();
		expect(sentDelay()).toBeUndefined();
	});

	it('sends no undoSendDelayMs when the user picked the 30s default explicitly', async () => {
		settingsData.value = { undoSendSeconds: 30 };
		const composer = await makeComposer();
		await composer.send();
		expect(sentDelay()).toBeUndefined();
	});

	it('sends the chosen window in milliseconds', async () => {
		settingsData.value = { undoSendSeconds: 60 };
		const composer = await makeComposer();
		await composer.send();
		expect(sentDelay()).toBe(60_000);
	});

	it('sends an explicit zero for Off, never an omission', async () => {
		settingsData.value = { undoSendSeconds: 0 };
		const composer = await makeComposer();
		await composer.send();
		expect(sentDelay()).toBe(0);
	});

	it('lets an explicit per-send window override the preference', async () => {
		settingsData.value = { undoSendSeconds: 60 };
		const composer = await makeComposer();
		await composer.send({ undoSendDelayMs: 5_000 });
		expect(sentDelay()).toBe(5_000);
	});

	it('keeps the window OUT of the offline payload, passing it beside instead', async () => {
		settingsData.value = { undoSendSeconds: 60 };
		isOffline.value = true;
		const composer = await makeComposer();
		await composer.send();

		expect(queueSend).toHaveBeenCalledOnce();
		const [payload, windowMs] = queueSend.mock.calls[0] as unknown as [
			{ sendOptions?: { undoSendDelayMs?: number } },
			number | undefined,
		];
		// The drain replays `sendOptions` verbatim — a window in there would
		// re-arm the hold after reconnect.
		expect(payload.sendOptions?.undoSendDelayMs).toBeUndefined();
		// …while the toast still counts down the sender's chosen window.
		expect(windowMs).toBe(60_000);
	});

	it('passes an Off window offline too, so no undo toast is offered', async () => {
		settingsData.value = { undoSendSeconds: 0 };
		isOffline.value = true;
		const composer = await makeComposer();
		await composer.send();
		const [, windowMs] = queueSend.mock.calls[0] as unknown as [unknown, number | undefined];
		expect(windowMs).toBe(0);
	});
});
