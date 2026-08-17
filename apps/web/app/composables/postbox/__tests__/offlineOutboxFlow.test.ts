/**
 * Offline outbox flow (adoption-gaps D8, piece E2) — the queue+drain seam
 * between usePostboxCompose.send() and usePostboxOfflineOutbox.
 *
 *   - an offline send enqueues the FULL payload and returns a synthetic
 *     {undoToken, sendAt} (composer emit contract unchanged, no network),
 *   - undo while offline un-queues the item, attachment refs included, so the
 *     reopened composer can re-queue it with nothing dropped,
 *   - the reconnect drain replays create → update → send per item, in queue
 *     order, threading the outbox item id as the draft clientNonce,
 *   - a partial drain keeps failed items (with lastError) visible,
 *   - rapid reconnect flaps never double-send (single-flight drain), and
 *     neither does an undo racing a reconnect: the drain CLAIMS an item before
 *     the first network call and undo refuses a claimed item,
 *   - and the ONLINE path is byte-identical to today (same mutations, same
 *     args, outbox untouched).
 *
 * The offline store is faked in-memory; the Convex backend is a scripted fake
 * behind both useBackendOperation (compose side) and useConvex (drain side).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

// The composables under test are stood up OUTSIDE a component setup here, so
// the `useI18n` auto-import resolves straight to a catalog-backed composer —
// the real English an offline sender reads, not a `t: (key) => key` stub.
const i18n = createTestI18n();

// ── @owlat/api markers ───────────────────────────────────────────────────
vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			drafts: {
				get: 'drafts.get',
				create: 'drafts.create',
				update: 'drafts.update',
				setIdentity: 'drafts.setIdentity',
				addAttachment: 'drafts.addAttachment',
				discard: 'drafts.discard',
				send: 'drafts.send',
				cancelPendingSend: 'drafts.cancelPendingSend',
				cancelScheduledSend: 'drafts.cancelScheduledSend',
			},
			identities: { listSendAsIdentities: 'identities.listSendAs' },
			signatures: { list: 'signatures.list' },
		},
	},
}));

// The attachments sibling pulls its own Convex context; stub it out.
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

// ── In-memory offline store (E1's contract, insertion-order preserving) ──
interface FakeItem {
	id: string;
	payload: Record<string, unknown> & {
		mailboxId: string;
		subject: string;
		toAddresses: string[];
		attachments: Array<{
			storageId: string;
			filename: string;
			contentType: string;
			size: number;
		}>;
	};
	queuedAt: number;
	attempts: number;
	lastError?: string;
	claimedAt?: number;
}

const fakeOutbox = {
	items: new Map<string, FakeItem[]>(), // ns -> ordered items
	nextId: 0,
	failEnqueue: false,
	failClaim: false,
	reset() {
		this.items.clear();
		this.nextId = 0;
		this.failEnqueue = false;
		this.failClaim = false;
	},
	list(ns: string): FakeItem[] {
		return this.items.get(ns) ?? [];
	},
};

class FakeOfflineWriteError extends Error {
	isQuotaExceeded = true;
}

// The claim helpers (`isOutboxClaimLive`, the TTL) are the REAL ones — the undo
// path and this fake store must agree on what "claimed" means, and a divergent
// re-implementation here would test nothing.
vi.mock('~/utils/postboxOfflineStore', async (importActual) => {
	const actual = await importActual<typeof import('~/utils/postboxOfflineStore')>();
	return {
		...actual,
		OfflineWriteError: FakeOfflineWriteError,
		getPostboxOfflineStore: () => ({
			async enqueueOutbox(ns: string, payload: FakeItem['payload']): Promise<FakeItem> {
				if (fakeOutbox.failEnqueue) {
					throw new FakeOfflineWriteError('This device is out of storage.');
				}
				const item: FakeItem = {
					id: `item-${++fakeOutbox.nextId}`,
					payload,
					// Monotonic so list order is deterministic under fast enqueues.
					queuedAt: fakeOutbox.nextId,
					attempts: 0,
				};
				fakeOutbox.items.set(ns, [...fakeOutbox.list(ns), item]);
				return item;
			},
			async listOutbox(ns: string): Promise<FakeItem[]> {
				return [...fakeOutbox.list(ns)];
			},
			async removeOutbox(ns: string, id: string): Promise<void> {
				fakeOutbox.items.set(
					ns,
					fakeOutbox.list(ns).filter((i) => i.id !== id)
				);
			},
			async claimOutbox(ns: string, id: string): Promise<FakeItem | null> {
				if (fakeOutbox.failClaim) throw new FakeOfflineWriteError('claim write failed');
				const item = fakeOutbox.list(ns).find((i) => i.id === id);
				if (!item || actual.isOutboxClaimLive(item)) return null;
				item.claimedAt = Date.now();
				return item;
			},
			async markOutboxAttempt(
				ns: string,
				id: string,
				lastError?: string
			): Promise<FakeItem | null> {
				const item = fakeOutbox.list(ns).find((i) => i.id === id);
				if (!item) return null;
				item.attempts += 1;
				// The attempt is over — hand the claim back (real store contract).
				delete item.claimedAt;
				if (lastError === undefined) delete item.lastError;
				else item.lastError = lastError;
				return item;
			},
			// Cache-side API (unused here, present so the cache composable loads).
			async saveThreads() {},
			async loadThreads() {
				return [];
			},
			async saveBody() {},
			async loadBody() {
				return null;
			},
			async clear() {},
			writesDisabled: false,
		}),
	};
});

// ── Scripted Convex backend behind both client seams ─────────────────────
interface BackendCall {
	op: string;
	args: Record<string, unknown>;
}

const backend = {
	calls: [] as BackendCall[],
	drafts: new Map<string, { state: string; attachments: { storageId: string }[] }>(),
	nonceIndex: new Map<string, string>(),
	nextDraft: 0,
	networkDown: false,
	/** subjects whose drafts.update call should fail (partial-drain case). */
	failUpdateForSubjects: new Set<string>(),
	/** When set, drafts.send awaits this before returning (flap case). */
	sendGate: null as Promise<void> | null,
	reset() {
		this.calls = [];
		this.drafts.clear();
		this.nonceIndex.clear();
		this.nextDraft = 0;
		this.networkDown = false;
		this.failUpdateForSubjects.clear();
		this.sendGate = null;
	},
	callsFor(op: string): BackendCall[] {
		return this.calls.filter((c) => c.op === op);
	},
	async call(op: string, args: Record<string, unknown>): Promise<unknown> {
		if (this.networkDown) {
			const err = new Error('fetch failed') as Error & { category: string };
			err.category = 'network';
			throw err;
		}
		this.calls.push({ op, args });
		switch (op) {
			case 'drafts.create': {
				const nonce = args['clientNonce'] as string | undefined;
				if (nonce && this.nonceIndex.has(nonce)) {
					return { draftId: this.nonceIndex.get(nonce), existing: true };
				}
				const draftId = `draft-${++this.nextDraft}`;
				this.drafts.set(draftId, { state: 'draft', attachments: [] });
				if (nonce) this.nonceIndex.set(nonce, draftId);
				return { draftId };
			}
			case 'drafts.get':
				return this.drafts.get(args['draftId'] as string) ?? null;
			case 'drafts.update': {
				if (this.failUpdateForSubjects.has(args['subject'] as string)) {
					throw new Error('scan rejected this message');
				}
				return { savedAt: Date.now() };
			}
			case 'drafts.send': {
				if (this.sendGate) await this.sendGate;
				const draft = this.drafts.get(args['draftId'] as string);
				if (draft) draft.state = 'pending_send';
				return { undoToken: `tok-${args['draftId']}`, sendAt: 123_456 };
			}
			default:
				return null;
		}
	},
};

const toasts: string[] = [];
// A test may script `backend.call`; restore the real one between tests.
const originalBackendCall = backend.call;

beforeEach(async () => {
	fakeOutbox.reset();
	backend.call = originalBackendCall;
	backend.reset();
	toasts.length = 0;
	localStorage.clear();

	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useToast', () => ({
		showToast: (msg: string) => {
			toasts.push(msg);
		},
	}));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref([]) }));
	vi.stubGlobal('useConvex', () => ({
		mutation: (op: string, args: Record<string, unknown>) => backend.call(op, args),
		query: (op: string, args: Record<string, unknown>) => backend.call(op, args),
	}));
	// Mirrors the real module's contract: run() resolves the backend result,
	// or normalizes a throw, offers it to onError (claimed → silent), and
	// returns undefined.
	vi.stubGlobal(
		'useBackendOperation',
		(op: string, opts?: { onError?: (e: { category: string; message: string }) => boolean }) => ({
			run: async (args: Record<string, unknown>) => {
				try {
					return await backend.call(op, args);
				} catch (e) {
					const err = e as Error & { category?: string };
					const normalized = {
						category: err.category ?? 'internal',
						message: err.message,
					};
					if (opts?.onError?.(normalized) !== true) toasts.push(normalized.message);
					return undefined;
				}
			},
			isLoading: ref(false),
			inlineError: ref(null),
		})
	);

	const cache = await import('../usePostboxOfflineCache');
	cache.__resetPostboxOfflineCacheState();
	const outbox = await import('../usePostboxOfflineOutbox');
	outbox.__resetPostboxOfflineOutboxState();
});

function goOffline() {
	window.dispatchEvent(new Event('offline'));
}
function goOnline() {
	window.dispatchEvent(new Event('online'));
}

async function makeComposer(fields?: { subject?: string; to?: string[]; body?: string }) {
	const { usePostboxCompose } = await import('../usePostboxCompose');
	const composer = usePostboxCompose({ mailboxId: 'mbx-1' as never });
	composer.toAddresses.value = fields?.to ?? ['rcpt@example.com'];
	composer.subject.value = fields?.subject ?? 'Hello';
	composer.bodyHtml.value = fields?.body ?? '<p>Body</p>';
	return composer;
}

async function makeOutbox() {
	const { usePostboxOfflineOutbox } = await import('../usePostboxOfflineOutbox');
	return usePostboxOfflineOutbox('mbx-1');
}

describe('offline send', () => {
	it('enqueues the full payload and returns a synthetic {undoToken, sendAt}', async () => {
		const composer = await makeComposer({ subject: 'Queued while offline' });
		goOffline();

		const before = Date.now();
		const result = await composer.send();

		// Synthetic contract: same shape as the server's, token self-describing.
		expect(result.undoToken).toMatch(/^outbox:mbx-1:item-1$/);
		expect(result.sendAt).toBeGreaterThanOrEqual(before);

		// Payload-complete on-device, nothing on the wire.
		const queued = fakeOutbox.list('mbx-1');
		expect(queued).toHaveLength(1);
		expect(queued[0]!.payload).toMatchObject({
			mailboxId: 'mbx-1',
			toAddresses: ['rcpt@example.com'],
			subject: 'Queued while offline',
			bodyHtml: '<p>Body</p>',
			composerMode: 'simple',
		});
		expect(backend.calls).toHaveLength(0);
	});

	it('surfaces a storage failure instead of pretending the send worked', async () => {
		const composer = await makeComposer();
		goOffline();
		fakeOutbox.failEnqueue = true;

		await expect(composer.send()).rejects.toThrow('Send failed');
		expect(toasts).toContain(i18n.global.t('shared.postbox.offlineOutbox.outOfStorage'));
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
	});

	it('a send whose transport drops mid-flight queues instead of erroring', async () => {
		const composer = await makeComposer({ subject: 'Flaky net' });
		// Online by state, but every backend call network-fails.
		backend.networkDown = true;

		const result = await composer.send();

		expect(result.undoToken).toMatch(/^outbox:mbx-1:/);
		expect(fakeOutbox.list('mbx-1')).toHaveLength(1);
		// The network failure was claimed by the queue path — no error toast.
		expect(toasts).toHaveLength(0);
	});
});

describe('offline undo', () => {
	it('un-queues the item and hands back its payload', async () => {
		const composer = await makeComposer({ subject: 'Take it back' });
		goOffline();
		const { undoToken } = await composer.send();
		expect(fakeOutbox.list('mbx-1')).toHaveLength(1);

		const outbox = await makeOutbox();
		const removed = await outbox.undoQueuedSend(undoToken);

		expect(removed?.payload.subject).toBe('Take it back');
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
		expect(outbox.queuedCount.value).toBe(0);
		// Nothing ever reached the server.
		expect(backend.calls).toHaveLength(0);
	});

	it('says so instead of pretending, when the item is already gone', async () => {
		const outbox = await makeOutbox();
		expect(await outbox.undoQueuedSend('outbox:mbx-1:item-99')).toBeNull();
		expect(toasts).toContain(i18n.global.t('shared.postbox.offlineOutbox.alreadySent'));
	});

	it('carries the attachment refs back into the composer, and into a re-send', async () => {
		const { usePostboxCompose } = await import('../usePostboxCompose');
		const attachment = {
			storageId: 'st-1',
			filename: 'invoice.pdf',
			contentType: 'application/pdf',
			size: 4096,
		};

		// Attachment refs only exist once committed to a server draft, so the
		// realistic shape is a draft that went offline before its send.
		const composer = usePostboxCompose({
			mailboxId: 'mbx-1' as never,
			draftId: 'draft-7' as never,
		});
		composer.toAddresses.value = ['rcpt@example.com'];
		composer.subject.value = 'With the invoice';
		composer.attachments.value = [attachment];
		goOffline();
		const { undoToken } = await composer.send();
		expect(fakeOutbox.list('mbx-1')[0]!.payload.attachments).toEqual([attachment]);

		const outbox = await makeOutbox();
		const item = await outbox.undoQueuedSend(undoToken);

		// Exactly the seed PostboxUndoSendToast hands stack.open().
		const reopened = usePostboxCompose({
			mailboxId: 'mbx-1' as never,
			draftId: item!.payload.draftId as never,
			prefillTo: item!.payload.toAddresses,
			prefillSubject: item!.payload.subject,
			prefillAttachments: item!.payload.attachments,
		});
		expect(reopened.attachments.value).toEqual([attachment]);

		// The round trip is lossless: re-queuing keeps the files attached, so
		// the drain sends the message the user actually composed.
		await reopened.send();
		expect(fakeOutbox.list('mbx-1')[0]!.payload.attachments).toEqual([attachment]);
	});
});

describe('undo racing the drain', () => {
	/**
	 * The reconnect lands while the "Queued — sends when you're back online"
	 * toast is still up. Without a claim, undo reads the item, un-queues it and
	 * reopens the composer while the drain is already sending it — the user then
	 * sends the same message a second time.
	 */
	it('refuses undo once the drain has claimed the item — no double-send', async () => {
		const composer = await makeComposer({ subject: 'Reconnect beat the click' });
		goOffline();
		const { undoToken } = await composer.send();

		let releaseSend!: () => void;
		backend.sendGate = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});

		const outbox = await makeOutbox();
		goOnline();
		const draining = outbox.drain();
		// Park the drain inside drafts.send — claimed, on the wire, not done.
		await vi.waitUntil(() => backend.callsFor('drafts.send').length === 1);

		// The Undo click lands in that window.
		expect(await outbox.undoQueuedSend(undoToken)).toBeNull();
		expect(toasts).toContain(i18n.global.t('shared.postbox.offlineOutbox.alreadySent'));

		releaseSend();
		backend.sendGate = null;
		await draining;

		// Sent exactly once, and no composer was handed back to send it again.
		expect(backend.callsFor('drafts.send')).toHaveLength(1);
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
	});

	it('still un-queues an item the drain has not claimed yet', async () => {
		const composer = await makeComposer({ subject: 'First' });
		goOffline();
		await composer.send();
		composer.subject.value = 'Second';
		const { undoToken: secondToken } = await composer.send();

		let releaseSend!: () => void;
		backend.sendGate = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});

		const outbox = await makeOutbox();
		goOnline();
		const draining = outbox.drain();
		await vi.waitUntil(() => backend.callsFor('drafts.send').length === 1);

		// 'Second' is still unclaimed — undo wins, and the drain must notice.
		const removed = await outbox.undoQueuedSend(secondToken);
		expect(removed?.payload.subject).toBe('Second');

		releaseSend();
		backend.sendGate = null;
		await draining;

		expect(backend.callsFor('drafts.update').map((c) => c.args['subject'])).toEqual(['First']);
		expect(backend.callsFor('drafts.send')).toHaveLength(1);
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
	});

	it('hands the claim back when the attempt fails, so undo works again', async () => {
		const composer = await makeComposer({ subject: 'Poisoned' });
		goOffline();
		const { undoToken } = await composer.send();
		backend.failUpdateForSubjects.add('Poisoned');

		const outbox = await makeOutbox();
		goOnline();
		await outbox.drain();
		expect(fakeOutbox.list('mbx-1')[0]!.lastError).toBe('scan rejected this message');

		const removed = await outbox.undoQueuedSend(undoToken);
		expect(removed?.payload.subject).toBe('Poisoned');
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
	});

	it('never sends an item it could not claim', async () => {
		const composer = await makeComposer({ subject: 'Unclaimable' });
		goOffline();
		await composer.send();
		fakeOutbox.failClaim = true;

		const outbox = await makeOutbox();
		goOnline();
		await outbox.drain();

		// Nothing on the wire, and the item is kept with the honest reason.
		expect(backend.calls).toHaveLength(0);
		const [item] = fakeOutbox.list('mbx-1');
		expect(item?.attempts).toBe(1);
		expect(item?.lastError).toBe('claim write failed');
		expect(outbox.failedCount.value).toBe(1);
	});
});

describe('drain on reconnect', () => {
	it('replays create → update → send per item, in queue order, nonce = item id', async () => {
		const composer = await makeComposer({ subject: 'First' });
		goOffline();
		await composer.send();
		composer.subject.value = 'Second';
		await composer.send();
		expect(fakeOutbox.list('mbx-1')).toHaveLength(2);

		const outbox = await makeOutbox();
		goOnline();
		await outbox.drain();

		// Everything sent, queue empty.
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
		expect(outbox.queuedCount.value).toBe(0);

		// Strict per-item order, oldest first.
		expect(backend.calls.map((c) => c.op)).toEqual([
			'drafts.create',
			'drafts.update',
			'drafts.send',
			'drafts.create',
			'drafts.update',
			'drafts.send',
		]);
		expect(backend.callsFor('drafts.update').map((c) => c.args['subject'])).toEqual([
			'First',
			'Second',
		]);
		// Idempotency key: the outbox item id rides as the draft client nonce.
		expect(backend.callsFor('drafts.create').map((c) => c.args['clientNonce'])).toEqual([
			'item-1',
			'item-2',
		]);
		// The offline undo window already elapsed — dispatch immediately.
		expect(backend.callsFor('drafts.send').map((c) => c.args['undoSendDelayMs'])).toEqual([0, 0]);
	});

	it('keeps failed items with lastError and still sends the rest', async () => {
		const composer = await makeComposer({ subject: 'Poisoned' });
		goOffline();
		await composer.send();
		composer.subject.value = 'Fine';
		await composer.send();

		backend.failUpdateForSubjects.add('Poisoned');
		const outbox = await makeOutbox();
		goOnline();
		await outbox.drain();

		const remaining = fakeOutbox.list('mbx-1');
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.payload.subject).toBe('Poisoned');
		expect(remaining[0]!.attempts).toBe(1);
		expect(remaining[0]!.lastError).toBe('scan rejected this message');
		expect(outbox.failedCount.value).toBe(1);

		// The healthy item went out exactly once.
		expect(backend.callsFor('drafts.send')).toHaveLength(1);
	});

	it('never double-sends on rapid reconnect flaps (single-flight)', async () => {
		const composer = await makeComposer({ subject: 'Once only' });
		goOffline();
		await composer.send();

		let releaseSend!: () => void;
		backend.sendGate = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});

		const outbox = await makeOutbox();
		goOnline();
		const first = outbox.drain();
		// Flap: offline and back online while the first drain is mid-send.
		goOffline();
		goOnline();
		await nextTick();
		const second = outbox.drain();
		expect(second).toBe(first); // the flap joins the in-flight drain

		releaseSend();
		backend.sendGate = null;
		await Promise.all([first, second]);
		await nextTick();

		expect(backend.callsFor('drafts.send')).toHaveLength(1);
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
	});

	it('a nonce hit whose draft already left `draft` resolves without re-sending', async () => {
		const composer = await makeComposer({ subject: 'Sent but response lost' });
		goOffline();
		await composer.send();

		// Simulate the lost-response attempt: the server already created the
		// draft for this nonce and the send went through.
		backend.nonceIndex.set('item-1', 'draft-ghost');
		backend.drafts.set('draft-ghost', { state: 'pending_send', attachments: [] });

		const outbox = await makeOutbox();
		goOnline();
		await outbox.drain();

		expect(backend.callsFor('drafts.send')).toHaveLength(0);
		expect(backend.callsFor('drafts.update')).toHaveLength(0);
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0); // resolved, not retried forever
	});
});

describe('online path', () => {
	it('is byte-identical to today: same mutations, same args, outbox untouched', async () => {
		const composer = await makeComposer({ subject: 'Plain online send' });

		const result = await composer.send();

		expect(result).toEqual({ undoToken: 'tok-draft-1', sendAt: 123_456 });
		// create carries NO clientNonce online, send passes the caller's opts
		// through untouched.
		expect(backend.callsFor('drafts.create')[0]!.args).toEqual({
			mailboxId: 'mbx-1',
			inReplyToMessageId: undefined,
		});
		expect(backend.callsFor('drafts.send')[0]!.args).toEqual({
			draftId: 'draft-1',
			undoSendDelayMs: undefined,
			scheduledSendAt: undefined,
			allowUnsealed: undefined,
		});
		// The outbox never sees an online send.
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
	});

	it('still throws on a non-network backend reject (no silent queueing)', async () => {
		const composer = await makeComposer({ subject: 'Rejected' });

		// A CATEGORIZED refusal (not a transport failure) must keep today's
		// treatment: toast + throw, never an offline enqueue.
		const scripted = backend.call.bind(backend);
		backend.call = (async (op: string, args: Record<string, unknown>) => {
			if (op === 'drafts.send') {
				const err = new Error('No recipients') as Error & { category: string };
				err.category = 'invalid_state';
				throw err;
			}
			return scripted(op, args);
		}) as typeof backend.call;

		await expect(composer.send()).rejects.toThrow('Send failed');
		expect(fakeOutbox.list('mbx-1')).toHaveLength(0);
		expect(toasts).toContain('No recipients');
	});
});
