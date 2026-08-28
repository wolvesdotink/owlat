/**
 * Convex wiring for the composer seal-lock indicator (Sealed Mail E5, flag
 * `sealedMail`). Reads the honest per-draft seal state (auth, mailbox-scoped)
 * from `api.mail.drafts.getComposerSealState` so the lock's promise matches what
 * the sender actually does at dispatch. Only subscribes once the draft exists and
 * the flag is on; the query re-runs on the draft's row, so it recomputes as
 * recipients change.
 *
 * The same read carries the PER-RECIPIENT key verdicts (plan idea 11), which the
 * envelope renders on the chips and the lock names as blockers. They are a view
 * of the very states the aggregate was derived from — public trust only, no key
 * material — so the two can never disagree about who is keyless.
 *
 * It also owns the SEND GATE for unsealable drafts: a message that can't be
 * sealed never downgrades quietly, so `blockSend` parks the attempted send and
 * asks the sender to proceed or cancel (`PostboxComposerSealConfirmDialog`).
 * Confirming replays the exact send that was attempted — scheduled time included
 * — with the explicit plaintext consent. Same shape as the team-inbox stale-reply
 * guard: the composer calls `blockSend(opts)` and hands back an `onConfirm`.
 *
 * Extracted from PostboxComposer.vue to keep that surface focused (and under the
 * file-size cap) — the composer just reads the returned `seal` facade.
 */

import { computed, reactive, ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { deriveUnsealedPrompt, sealSendBlock, type SealState } from '~/utils/sealComposer';
import {
	allRecipientsVerified,
	sealBlockingRecipients,
	type RecipientSealView,
} from '~/utils/sealRecipients';

/** The send options parked while the sender decides; replayed on confirm. */
export type SealGateSendOptions = { scheduledSendAt?: number; allowUnsealed?: boolean };

export function usePostboxComposerSealLock(
	draftId: () => Id<'mailDrafts'> | undefined,
	options: {
		/**
		 * Flush the debounced autosave so a still-computing state can settle. The
		 * resolved value is ignored (the composer's flush hands back the draft id),
		 * so any promise is accepted here.
		 */
		flush: () => Promise<unknown>;
		/** Replay the parked send once the sender accepts plaintext delivery. */
		onConfirm: (opts: SealGateSendOptions) => void;
	}
) {
	const { isEnabled } = useFeatureFlag();
	const { showToast } = useToast();
	const { t } = useI18n();
	const sealedMailEnabled = computed(() => isEnabled('sealedMail'));

	const sealStateQuery = useConvexQuery(api.mail.drafts.getComposerSealState, () => {
		const id = draftId();
		return sealedMailEnabled.value && id ? { draftId: id } : ('skip' as const);
	});

	/** The query's whole answer: the aggregate verdict plus its recipient views. */
	const sealView = computed(
		() =>
			(sealStateQuery.data.value ?? null) as {
				state: SealState;
				recipients: RecipientSealView[];
			} | null
	);

	const composerSealState = computed(() => sealView.value?.state ?? null);
	const sealRecipients = computed<RecipientSealView[]>(() => sealView.value?.recipients ?? []);
	/** Who to name (with a remove affordance) when a missing key is the blocker. */
	const blockingRecipients = computed(() =>
		sealBlockingRecipients(composerSealState.value, sealRecipients.value)
	);
	/**
	 * Every recipient's key has been verified by a human here (plan idea 54) —
	 * the lock's stronger wording. Display only: it feeds no send gate, so a
	 * verified draft and an unverified one are sent by exactly the same path.
	 */
	const allVerified = computed(() => allRecipientsVerified(sealRecipients.value));

	// True while the answer is still on its way for a draft that exists — the lock
	// says "checking" rather than staying blank, so the sender is never left to
	// assume something about sealing that hasn't been decided yet.
	const composerSealPending = computed(
		() => sealedMailEnabled.value && !!draftId() && sealStateQuery.data.value === undefined
	);

	const confirmOpen = ref(false);
	const parkedSend = ref<SealGateSendOptions | null>(null);

	/** Open the proceed-or-cancel prompt; false when this state has none to offer. */
	function requestUnsealed(opts?: SealGateSendOptions): boolean {
		if (!deriveUnsealedPrompt(composerSealState.value)) return false;
		parkedSend.value = { ...opts };
		confirmOpen.value = true;
		return true;
	}

	function setConfirmOpen(open: boolean) {
		confirmOpen.value = open;
		// Cancelling drops the parked send: the next attempt must ask again.
		if (!open) parkedSend.value = null;
	}

	function confirmUnsealed() {
		const opts = parkedSend.value ?? {};
		setConfirmOpen(false);
		options.onConfirm({ ...opts, allowUnsealed: true });
	}

	/**
	 * The composer's seal gate: true when this send must not proceed as asked.
	 * Mirrors the server's own gate (`sealSendBlock`) and always leaves the sender
	 * with something to do — wait for the check, resolve the key change on the
	 * thread, or answer the unsealed prompt.
	 */
	async function blockSend(opts?: SealGateSendOptions): Promise<boolean> {
		const block = sealSendBlock(
			sealedMailEnabled.value,
			composerSealState.value,
			opts?.allowUnsealed === true
		);
		if (!block) return false;
		if (block === 'checking') {
			await options.flush();
			showToast(t('shared.postbox.usePostboxComposerSealLock.checking'));
		} else if (block === 'key_changed') {
			showToast(t('shared.postbox.usePostboxComposerSealLock.keyChanged'));
		} else if (!requestUnsealed(opts)) {
			// No prompt exists only when there is nothing to decide yet (no recipients).
			showToast(t('shared.postbox.usePostboxComposerSealLock.noRecipients'));
		}
		return true;
	}

	// `reactive` (not a bag of refs) so the template can read `seal.state` /
	// `seal.confirmOpen` directly — nested refs are unwrapped on access.
	return reactive({
		enabled: sealedMailEnabled,
		state: composerSealState,
		recipients: sealRecipients,
		blockingRecipients,
		allVerified,
		pending: composerSealPending,
		confirmOpen,
		blockSend,
		requestUnsealed,
		confirmUnsealed,
		setConfirmOpen,
	});
}
