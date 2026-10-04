/**
 * Undo-send window reaching the wire (plan idea 8).
 *
 * The backend has accepted `undoSendDelayMs` on `mail.drafts.send` all along;
 * without it the server applies its own default (10s since plan Q1). These
 * tests pin the things that make the preference safe:
 *
 *   - an UNSET preference sends no `undoSendDelayMs` at all — a user who never
 *     opens the setting produces the exact mutation args the composer produced
 *     before it existed, and the server keeps owning the default;
 *   - a chosen window (10 / 60) travels in milliseconds, and 'Off' travels as an
 *     explicit `0` rather than being omitted (omitting it would silently mean
 *     the 10s default — the opposite of what the sender asked for);
 *   - a stored 30s (the default before plan Q1) travels explicitly too, so the
 *     lower default only moves users who never picked a window; and
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

/** The undo toast's window: send() arms it after every send that went out. */
const undoArm = vi.fn();
vi.mock('../usePostboxUndoSend', () => ({ usePostboxUndoSend: () => ({ arm: undoArm }) }));

/** Stand-in for the offline outbox so the offline branch is observable. */
const queueSend = vi.fn(async () => ({ undoToken: 'outbox:ns:1', sendAt: 0 }));
const isOffline = ref(false);
vi.mock('../usePostboxOfflineOutbox', () => ({
	usePostboxOfflineOutbox: () => ({ isOffline, queueSend }),
	isQueuedSendToken: (token: string) => token.startsWith('outbox:'),
	OFFLINE_QUEUE_UNDO_WINDOW_MS: 10_000,
}));

/** The saved `mailUserSettings` row the settings query answers with. */
let settingsData: Ref<{ undoSendSeconds?: number } | null>;
let sendRun: Mock;

beforeEach(() => {
	settingsData = ref(null);
	isOffline.value = false;
	queueSend.mockClear();
	undoArm.mockClear();

	vi.stubGlobal('useConvexQuery', (fn: unknown) => {
		if (fn === 'settings.get') return { data: settingsData, isLoading: ref(false) };
		return { data: ref(undefined), error: ref(null), isLoading: ref(false) };
	});
	sendRun = vi.fn(async () => ({ ok: true, result: { undoToken: 'tok', sendAt: 1 } }));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useBackendOperation', (fn: unknown) => {
		if (fn === 'drafts.send') return { run: sendRun, isLoading: ref(false) };
		if (fn === 'drafts.create')
			return {
				run: vi.fn(async () => ({
					ok: true,
					result: { draftId: 'draft-new', toAddresses: [], subject: '' },
				})),
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
	return (sendRun.mock.calls[0]![0] as { undoSendDelayMs?: number }).undoSendDelayMs;
}

describe('usePostboxCompose — undo-send window on the wire', () => {
	it('sends no undoSendDelayMs when the preference was never set', async () => {
		const composer = await makeComposer();
		await composer.send();
		expect(sendRun).toHaveBeenCalledOnce();
		expect(sentDelay()).toBeUndefined();
	});

	it('sends no undoSendDelayMs when the user picked the 10s default explicitly', async () => {
		settingsData.value = { undoSendSeconds: 10 };
		const composer = await makeComposer();
		await composer.send();
		expect(sentDelay()).toBeUndefined();
	});

	it('keeps a stored 30s choice (the old default) on the wire (plan Q1)', async () => {
		settingsData.value = { undoSendSeconds: 30 };
		const composer = await makeComposer();
		await composer.send();
		expect(sentDelay()).toBe(30_000);
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

describe('usePostboxCompose — send arms the undo window', () => {
	it('arms it once, for the seed mailbox, with the token the send returned', async () => {
		const composer = await makeComposer();
		const sent = await composer.send();
		expect(sent).toEqual({ undoToken: 'tok', sendAt: 1 });
		expect(undoArm).toHaveBeenCalledOnce();
		expect(undoArm).toHaveBeenCalledWith({ undoToken: 'tok', sendAt: 1, mailboxId: 'mbx-1' });
	});

	it('arms it for a scheduled send too, as the hosts did before', async () => {
		const composer = await makeComposer();
		await composer.send({ scheduledSendAt: 5_000 });
		expect(undoArm).toHaveBeenCalledOnce();
	});

	it('arms it with the synthetic token when the send is queued offline', async () => {
		isOffline.value = true;
		const composer = await makeComposer();
		await composer.send();
		expect(undoArm).toHaveBeenCalledOnce();
		expect(undoArm).toHaveBeenCalledWith({
			undoToken: 'outbox:ns:1',
			sendAt: 0,
			mailboxId: 'mbx-1',
		});
	});

	it('does not arm it when the server refuses the send', async () => {
		sendRun.mockResolvedValueOnce({ ok: false });
		const composer = await makeComposer();
		await expect(composer.send()).rejects.toThrow('Send failed');
		expect(undoArm).not.toHaveBeenCalled();
	});
});
