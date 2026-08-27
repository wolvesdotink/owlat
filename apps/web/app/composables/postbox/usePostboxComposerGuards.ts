/**
 * The composer's confidence layer: everything the client can tell you about a
 * send BEFORE it happens, computed deterministically and with the `ai` flag off.
 *
 * Four checks live here, in the order they interrupt a send:
 *
 *   1. ALIGNMENT (plan idea 3) — the From-picker already knows this identity's
 *      domain is unverified or its transport misaligned, i.e. that the message
 *      is going to be rejected. Until now nothing on the send path read that
 *      verdict, so the user learned it from a bounce. Warns, never hard-blocks:
 *      a self-hoster mid-setup must still be able to send.
 *   2. ATTACHMENT (idea 15) — the reworked forgot-attachment hint, now through
 *      the shared themed dialog instead of a native `window.confirm`.
 *   3. FIRST-TIME RECIPIENTS (idea 5) — an address this mailbox has never
 *      written to, which is how an autocomplete mis-pick leaves the building.
 *      A one-line inline confirm, not a modal.
 *   4. PREFLIGHT (idea 6) — empty subject, leftover `[TODO]`, unfilled
 *      `{{firstName}}`, link text that disagrees with its href. Advisory only:
 *      a quiet chip beside Send, never an interruption.
 *
 * WARNING BUDGET. Interruptions are the scarce resource: only the two
 * irreversible mistakes (a send that will fail, a message missing its
 * attachment) get the replay-confirm dialog. Everything else is a chip or an
 * inline line, and every gate asks ONCE per composer — acknowledged means
 * acknowledged.
 *
 * All four gates use the established `blockSend(opts)` + `onConfirm` replay
 * contract (see usePostboxStaleReplyGuard / usePostboxComposerSealLock): the
 * composer calls `blockSend`, returns early if it is true, and the guard
 * replays the exact send — scheduled time and all — once the user decides.
 */

import { computed, reactive, ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { detectMissingAttachment, type AttachmentHint } from '~/utils/attachmentMention';
import { preflightDraft, type PreflightFinding } from '~/utils/postboxPreflight';
import { canonicalEmailAddress, firstTimeRecipients } from '~/utils/recipientHints';
import {
	alignmentSendWarning,
	selectedSenderIdentity,
	type AlignableIdentity,
	type SenderAuthDisplay,
} from '~/utils/senderAlignment';

/** The send options parked while the sender decides; replayed verbatim. */
export type GuardSendOptions = { scheduledSendAt?: number; allowUnsealed?: boolean };

export interface ComposerGuardSources {
	mailboxId: () => Id<'mailboxes'> | undefined;
	/** Every identity the composer may send as, and the chosen From. */
	identities: () => readonly AlignableIdentity[];
	fromAddress: () => string;
	subject: () => string;
	bodyHtml: () => string;
	/** Recipients across To/Cc/Bcc, raw as typed. */
	recipients: () => string[];
	attachmentCount: () => number;
}

/**
 * One ask-once gate: park the attempted send, let the surface decide, replay.
 * Cancelling leaves the gate armed (the next attempt asks again); confirming or
 * dismissing settles it for the life of this composer.
 */
function createReplayGate(onConfirm: (opts?: GuardSendOptions) => void) {
	const open = ref(false);
	const acknowledged = ref(false);
	let parked: GuardSendOptions | undefined;

	return {
		open,
		acknowledged,
		/** True when the send must pause here — the caller returns early. */
		block(active: boolean, opts?: GuardSendOptions): boolean {
			if (!active || acknowledged.value) return false;
			parked = opts;
			open.value = true;
			return true;
		},
		confirm() {
			open.value = false;
			acknowledged.value = true;
			onConfirm(parked);
		},
		/** Settle without sending: the sender read the warning and went back. */
		dismiss() {
			open.value = false;
			acknowledged.value = true;
		},
		setOpen(value: boolean) {
			// Cancelling drops the parked send; the next attempt asks again.
			open.value = value;
		},
	};
}

export function usePostboxComposerGuards(
	sources: ComposerGuardSources,
	options: { onConfirm: (opts?: GuardSendOptions) => void }
) {
	// The attachment hint matches the active language's phrasing (plus English,
	// which people write in regardless of what the UI says).
	const { locale } = useI18n();

	// ── Recipient intelligence (ideas 4 + 5) ─────────────────────────────────
	// Two reads, deliberately separate: the domain corpus is per-mailbox and so
	// stays subscribed while chips come and go, while the known-recipient answer
	// is per-recipient-set and re-asks as the envelope changes.
	const canonicalRecipients = computed(() =>
		sources
			.recipients()
			.map(canonicalEmailAddress)
			.filter((address) => address.includes('@'))
	);

	const { data: knownData } = useConvexQuery(api.mail.contacts.knownRecipients, () => {
		const mailboxId = sources.mailboxId();
		const emails = canonicalRecipients.value;
		return mailboxId && emails.length > 0 ? { mailboxId, emails } : ('skip' as const);
	});
	const { data: domainData } = useConvexQuery(api.mail.contacts.correspondentDomains, () => {
		const mailboxId = sources.mailboxId();
		return mailboxId ? { mailboxId } : ('skip' as const);
	});

	/** Domains this mailbox writes to — the did-you-mean hint's first corpus. */
	const knownDomains = computed<string[]>(() => domainData.value ?? []);

	/**
	 * Recipients never written to before. Empty while the answer is in flight:
	 * an unanswered query is not evidence of a stranger, and branding a close
	 * colleague "first time" for a beat would discredit the cue permanently.
	 */
	const firstTimeAddresses = computed<string[]>(() =>
		knownData.value === undefined ? [] : firstTimeRecipients(sources.recipients(), knownData.value)
	);

	// ── Advisory preflight (idea 6) ──────────────────────────────────────────
	const preflight = computed<PreflightFinding[]>(() =>
		preflightDraft({ subject: sources.subject(), bodyHtml: sources.bodyHtml() })
	);

	// ── The verdicts the two dialogs speak with ──────────────────────────────
	const alignmentWarning = computed<SenderAuthDisplay | null>(() => {
		const identity = selectedSenderIdentity(sources.identities(), sources.fromAddress());
		return alignmentSendWarning(
			identity
				? {
						verified: identity.domainVerified,
						alignment: identity.alignment,
						reason: identity.alignmentReason ?? null,
					}
				: null
		);
	});

	const attachmentHint = computed<AttachmentHint | null>(() =>
		detectMissingAttachment({
			subject: sources.subject(),
			bodyHtml: sources.bodyHtml(),
			hasAttachments: sources.attachmentCount() > 0,
			locale: locale.value,
		})
	);

	const alignmentGate = createReplayGate(options.onConfirm);
	const attachmentGate = createReplayGate(options.onConfirm);
	const firstTimeGate = createReplayGate(options.onConfirm);

	/**
	 * The composer's confidence gate: true when this send must pause. Ordered
	 * worst-first, and each gate asks once — a send that trips two of them walks
	 * through them one replay at a time.
	 */
	function blockSend(opts?: GuardSendOptions): boolean {
		if (alignmentGate.block(alignmentWarning.value !== null, opts)) return true;
		if (attachmentGate.block(attachmentHint.value !== null, opts)) return true;
		return firstTimeGate.block(firstTimeAddresses.value.length > 0, opts);
	}

	// `reactive` (not a bag of refs) so a template can read `guards.preflight`
	// directly — the same facade shape usePostboxComposerSealLock returns.
	return reactive({
		knownDomains,
		firstTimeAddresses,
		preflight,
		alignmentWarning,
		attachmentHint,
		alignment: alignmentGate,
		attachment: attachmentGate,
		firstTime: firstTimeGate,
		blockSend,
	});
}

export type ComposerGuards = ReturnType<typeof usePostboxComposerGuards>;
