/**
 * Offline outbox flow (adoption-gaps D8): queue sends composed offline, drain
 * them on reconnect.
 *
 * Queue side — `usePostboxCompose.send()` calls {@link queueSend} when the
 * device is offline (or a send network-fails): the FULL compose payload goes
 * into the durable `outbox:{ns}` store and the caller gets a synthetic
 * `{ undoToken, sendAt }`, so the composer's emit contract is unchanged. The
 * synthetic token is self-describing (`outbox:{ns}:{itemId}`); the undo toast
 * recognizes it via {@link isQueuedSendToken} and undo becomes an un-queue
 * ({@link usePostboxOfflineOutbox.undoQueuedSend}) instead of a server cancel.
 *
 * Drain side — riding the shared `online` state the offline cache already
 * maintains (usePostboxOfflineCache's window listener), each queued item is
 * replayed through the NORMAL `drafts.create → update → send` mutations, in
 * queue order, single-flight per namespace. Idempotency: the outbox item id is
 * passed as the draft `clientNonce`, so a retry after a lost response reuses
 * the draft the first attempt created — and if that draft has already left
 * `'draft'` (the send went through), the item resolves without re-sending.
 * Failed items are kept with `lastError` (never silently dropped) and
 * surfaced via {@link usePostboxOfflineOutbox.failedCount}.
 *
 * Undo vs drain — the two sides race whenever the connection returns while the
 * "Queued" toast is still up. The drain CLAIMS an item (a `claimedAt` stamp,
 * written before its first network call) and undo refuses a claimed item, so
 * exactly one of the two wins: either the message is un-queued and never sent,
 * or it is sent and no composer is handed back to send it a second time.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	getPostboxOfflineStore,
	isOutboxClaimLive,
	OfflineWriteError,
	type OfflineComposePayload,
	type OfflineOutboxItem,
} from '~/utils/postboxOfflineStore';
import { usePostboxOfflineCache } from './usePostboxOfflineCache';

const QUEUED_TOKEN_PREFIX = 'outbox:';

/**
 * Undo window shown for a queued (offline) send — mirrors the server's
 * `DEFAULT_UNDO_SEND_DELAY_MS` so the toast counts down exactly like an online
 * send. The item stays un-queueable for as long as it is queued; the window
 * only bounds the toast.
 */
export const OFFLINE_QUEUE_UNDO_WINDOW_MS = 30_000;

/** True for the synthetic undo tokens minted by {@link queueSend}. */
export function isQueuedSendToken(undoToken: string): boolean {
	return undoToken.startsWith(QUEUED_TOKEN_PREFIX);
}

function makeQueuedToken(ns: string, itemId: string): string {
	return `${QUEUED_TOKEN_PREFIX}${ns}:${itemId}`;
}

function parseQueuedToken(undoToken: string): { ns: string; itemId: string } | null {
	if (!isQueuedSendToken(undoToken)) return null;
	const rest = undoToken.slice(QUEUED_TOKEN_PREFIX.length);
	const sep = rest.indexOf(':');
	if (sep <= 0 || sep === rest.length - 1) return null;
	return { ns: rest.slice(0, sep), itemId: rest.slice(sep + 1) };
}

const IS_CLIENT = typeof window !== 'undefined';

interface OutboxCounts {
	queued: number;
	failed: number;
}

/** Module-scoped reactive per-namespace counts so every caller shares one truth. */
let countsRef: Ref<Record<string, OutboxCounts>> | null = null;
/** Single-flight drain locks, one per namespace (R4: no double-send on flaps). */
const drainInFlight = new Map<string, Promise<void>>();

/** Test-only: reset the shared module state between cases. */
export function __resetPostboxOfflineOutboxState() {
	countsRef = null;
	drainInFlight.clear();
}

/**
 * Deep plain-copy for payloads headed to IndexedDB's structured-clone boundary
 * — compose field values can be reactive proxies (same rationale as the cache
 * side's `toPlain`).
 */
function toPlainPayload(payload: OfflineComposePayload): OfflineComposePayload {
	return JSON.parse(JSON.stringify(payload)) as OfflineComposePayload;
}

/**
 * Diagnostic marker stored on a failed item's `lastError`. Never rendered — the
 * banner reports the COUNT of stuck items, not each item's reason — so this
 * stays an English developer string rather than a catalog key.
 */
function errorMessage(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	return 'Send failed';
}

/**
 * @param mailboxId Active mailbox id — the outbox namespace this instance
 *   queues into, counts, and drains. Callers that only consume tokens (the
 *   undo toast) may omit it: the token carries its own namespace.
 */
export function usePostboxOfflineOutbox(mailboxId?: MaybeRefOrGetter<string | undefined>) {
	const { isOnline, isOffline } = usePostboxOfflineCache(mailboxId);
	const { showToast } = useToast();
	const { t } = useI18n();
	// The Convex client for the drain replays. Deliberately NOT
	// useBackendOperation: per-item failures are bookkept on the item
	// (`lastError`) and surfaced in the banner — a toast per failed queued
	// item on reconnect would be a toast storm.
	const client = useConvex();

	const namespace = computed(() => {
		const id = toValue(mailboxId);
		return id ? String(id) : null;
	});

	if (!countsRef) countsRef = ref<Record<string, OutboxCounts>>({});
	const counts = countsRef;

	const queuedCount = computed(() => {
		const ns = namespace.value;
		return ns ? (counts.value[ns]?.queued ?? 0) : 0;
	});
	const failedCount = computed(() => {
		const ns = namespace.value;
		return ns ? (counts.value[ns]?.failed ?? 0) : 0;
	});

	function store() {
		return IS_CLIENT ? getPostboxOfflineStore() : null;
	}

	async function refreshCounts(ns: string): Promise<void> {
		const s = store();
		if (!s) return;
		try {
			const items = await s.listOutbox(ns);
			counts.value = {
				...counts.value,
				[ns]: {
					queued: items.length,
					failed: items.filter((i) => i.lastError !== undefined).length,
				},
			};
		} catch {
			// A failed count read only staffs the banner — never break the caller.
		}
	}

	/**
	 * Queue a send composed offline. Returns the synthetic `{ undoToken,
	 * sendAt }` the composer's emit contract expects. Throws (after toasting
	 * the honest reason) when the device cannot store the message — a send
	 * must never silently vanish.
	 */
	async function queueSend(
		payload: OfflineComposePayload
	): Promise<{ undoToken: string; sendAt: number }> {
		const s = store();
		if (!s) throw new Error('Send failed');
		const ns = payload.mailboxId;
		let item: OfflineOutboxItem;
		try {
			item = await s.enqueueOutbox(ns, toPlainPayload(payload));
		} catch (err) {
			// The store's own Error messages are diagnostic; the sentence the
			// sender reads is picked here, from the same condition the store used.
			showToast(
				t(
					err instanceof OfflineWriteError && err.isQuotaExceeded
						? 'shared.postbox.offlineOutbox.outOfStorage'
						: 'shared.postbox.offlineOutbox.storageUnavailable'
				),
				'error'
			);
			throw new Error('Send failed');
		}
		await refreshCounts(ns);
		return {
			undoToken: makeQueuedToken(ns, item.id),
			// Same shape the server returns: the scheduled time, or now + the
			// undo window (caller's delay when given, server-default otherwise).
			sendAt:
				payload.sendOptions?.scheduledSendAt ??
				Date.now() + (payload.sendOptions?.undoSendDelayMs ?? OFFLINE_QUEUE_UNDO_WINDOW_MS),
		};
	}

	/**
	 * Un-queue a send by its synthetic undo token (the offline undo action).
	 * Returns the removed item so the caller can reopen the composer seeded
	 * from its payload, or `null` when undo came too late — the item is gone
	 * (already drained) or CLAIMED by an in-flight drain. Refusing a claimed
	 * item is what keeps a reconnect landing inside the undo window from
	 * sending the message and handing the user a composer to send it again.
	 * Both refusals say so out loud rather than dismissing into silence.
	 */
	async function undoQueuedSend(undoToken: string): Promise<OfflineOutboxItem | null> {
		const s = store();
		const parsed = parseQueuedToken(undoToken);
		if (!s || !parsed) return null;
		const items = await s.listOutbox(parsed.ns);
		const item = items.find((i) => i.id === parsed.itemId) ?? null;
		if (!item || isOutboxClaimLive(item)) {
			showToast(t('shared.postbox.offlineOutbox.alreadySent'), 'info');
			await refreshCounts(parsed.ns);
			return null;
		}
		await s.removeOutbox(parsed.ns, parsed.itemId);
		await refreshCounts(parsed.ns);
		return item;
	}

	/** Replay one queued item through the normal create → update → send path. */
	async function replayItem(ns: string, item: OfflineOutboxItem): Promise<void> {
		if (!client) throw new Error('Backend unavailable');
		const p = item.payload;
		let draftId = (p.draftId as Id<'mailDrafts'> | undefined) ?? null;
		let existingAttachmentIds: Set<string> | null = null;

		if (!draftId) {
			const created = await client.mutation(api.mail.drafts.create, {
				mailboxId: p.mailboxId as Id<'mailboxes'>,
				inReplyToMessageId: p.inReplyToMessageId as Id<'mailMessages'> | undefined,
				// Idempotency key: a retry after a lost response reuses the draft
				// the first attempt created instead of forking a duplicate.
				clientNonce: item.id,
			});
			draftId = created.draftId;
			if (created.existing) {
				const row = await client.query(api.mail.drafts.get, { draftId });
				// The nonce matched a draft that already left 'draft': the previous
				// attempt's send went through and only the response was lost. Done —
				// re-sending here would be the double-send R4 guards against.
				if (!row || row.state !== 'draft') return;
				existingAttachmentIds = new Set(
					(row.attachments ?? []).map((a: { storageId: string }) => a.storageId)
				);
			}
			for (const a of p.attachments) {
				if (existingAttachmentIds?.has(a.storageId)) continue;
				await client.mutation(api.mail.drafts.addAttachment, {
					draftId,
					storageId: a.storageId as Id<'_storage'>,
					filename: a.filename,
					contentType: a.contentType,
					size: a.size,
				});
			}
			// Identity can only have been chosen while a server round-trip was
			// possible, so a payload WITH a fromAddress but WITHOUT a draftId is
			// rare — restore it on the drain-created draft.
			if (p.fromAddress) {
				await client.mutation(api.mail.drafts.setIdentity, {
					draftId,
					fromAddress: p.fromAddress,
				});
			}
		}

		await client.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: p.toAddresses,
			ccAddresses: p.ccAddresses,
			bccAddresses: p.bccAddresses,
			subject: p.subject,
			bodyHtml: p.bodyHtml,
			bodyBlocks: p.composerMode === 'full' ? p.bodyBlocks : undefined,
			composerMode: p.composerMode,
			followUpRemindAt: p.followUpRemindAt ?? null,
		});
		await client.mutation(api.mail.drafts.send, {
			draftId,
			// The user had their undo window while the item sat in the queue —
			// dispatch immediately unless the payload asked for its own window.
			undoSendDelayMs: p.sendOptions?.undoSendDelayMs ?? 0,
			scheduledSendAt: p.sendOptions?.scheduledSendAt,
			allowUnsealed: p.sendOptions?.allowUnsealed,
		});
	}

	async function runDrain(ns: string): Promise<void> {
		const s = store();
		if (!s || !client) return;
		const items = await s.listOutbox(ns);
		for (const item of items) {
			// Went offline again mid-drain: stop, the rest stays queued.
			if (!isOnline.value) break;
			let claimed: OfflineOutboxItem | null;
			try {
				// Claim BEFORE any network call: from here on undo refuses this
				// item, so it cannot be un-queued into a composer while the very
				// same message is being sent.
				claimed = await s.claimOutbox(ns, item.id);
			} catch (err) {
				// The claim could not be written. Replaying unclaimed would reopen
				// exactly the race the claim exists to close — leave it queued.
				await s.markOutboxAttempt(ns, item.id, errorMessage(err)).catch(() => {});
				continue;
			}
			// Undone (or claimed elsewhere) between the list read and here.
			if (!claimed) continue;
			try {
				await replayItem(ns, claimed);
				await s.removeOutbox(ns, item.id);
			} catch (err) {
				// Keep the item, with the honest reason — never silently drop it.
				// markOutboxAttempt also drops the claim, so a failed item is
				// undoable again.
				await s.markOutboxAttempt(ns, item.id, errorMessage(err)).catch(() => {});
			}
		}
		await refreshCounts(ns);
	}

	/**
	 * Drain this namespace's queue, single-flight: concurrent calls (rapid
	 * online/offline flaps firing the listener repeatedly) share one run.
	 */
	function drain(): Promise<void> {
		const ns = namespace.value;
		if (!ns || !IS_CLIENT) return Promise.resolve();
		const inFlight = drainInFlight.get(ns);
		if (inFlight) return inFlight;
		const run = runDrain(ns).finally(() => {
			drainInFlight.delete(ns);
		});
		drainInFlight.set(ns, run);
		return run;
	}

	// Drain on reconnect — rides the shared `online` listener the offline
	// cache already registered (this ref is what that listener drives).
	watch(isOnline, (online, was) => {
		if (online && !was) void drain();
	});

	// On setup: refresh the badge count, and drain anything a previous session
	// left queued (e.g. the app was closed while offline).
	if (IS_CLIENT && namespace.value) {
		const ns = namespace.value;
		void refreshCounts(ns).then(() => {
			if (isOnline.value && (counts.value[ns]?.queued ?? 0) > 0) void drain();
		});
	}

	return {
		isOnline,
		isOffline,
		queuedCount,
		failedCount,
		queueSend,
		undoQueuedSend,
		drain,
	};
}
