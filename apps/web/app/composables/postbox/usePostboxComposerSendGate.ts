/**
 * The composer's send path: every gate a send passes, in order, then the send.
 *
 *   1. an upload still in flight — say why Send is waiting (a toast), because
 *      a mid-upload send would drop the file;
 *   2. Sealed Mail (E5) — an unsealable draft stops until the sender decides;
 *      nothing goes out in plaintext by omission;
 *   3. the confidence layer (usePostboxComposerGuards: DMARC alignment, the
 *      missing attachment, a first-time recipient) — each asked once;
 *   4. team-inbox collision safety (usePostboxStaleReplyGuard) — a teammate
 *      replied after this reply opened.
 *
 * Every gate parks the send and replays it verbatim (scheduled time and all)
 * once answered, through `handleSend`. Lifted out of PostboxComposer.vue for the
 * file-size ratchet; the order and the behaviour are the ones it had there.
 */
import type { Id } from '@owlat/api/dataModel';
import type { ComposerSeed } from './usePostboxCompose';
import type { AlignableIdentity } from '~/utils/senderAlignment';

type SendOptions = { scheduledSendAt?: number; allowUnsealed?: boolean };

export function usePostboxComposerSendGate(opts: {
	seed: () => ComposerSeed;
	identities: () => readonly AlignableIdentity[];
	fromAddress: () => string;
	subject: () => string;
	bodyHtml: () => string;
	recipients: () => string[];
	attachmentCount: () => number;
	isUploading: () => boolean;
	canSend: () => boolean;
	/** The seal lock (a getter: it is wired with this gate's own `handleSend`). */
	seal: () => { blockSend: (opts?: SendOptions) => Promise<boolean> };
	send: (opts?: SendOptions) => Promise<unknown>;
	/** Reached only when it sent (or queued offline); the undo window is armed. */
	onSent: (outcome: { scheduled: boolean }) => void;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { showOperationError } = useOperationErrorToast();
	const sending = ref(false);

	const staleGuard = usePostboxStaleReplyGuard(
		() => opts.seed().inReplyToMessageId as Id<'mailMessages'> | undefined,
		{ onConfirm: (o) => void handleSend(o) }
	);

	const guards = usePostboxComposerGuards(
		{
			mailboxId: () => opts.seed().mailboxId,
			identities: opts.identities,
			fromAddress: opts.fromAddress,
			subject: opts.subject,
			bodyHtml: opts.bodyHtml,
			recipients: opts.recipients,
			attachmentCount: opts.attachmentCount,
		},
		{ onConfirm: (o) => void handleSend(o) }
	);

	async function handleSend(sendOpts?: SendOptions) {
		// Keep this above the canSend short-circuit so the toast still fires when
		// uploading is the sole blocker (Send is disabled, Cmd/Ctrl+Enter is not).
		if (opts.isUploading()) {
			showToast(t('components.postbox.postboxComposer.uploadingToast'));
			return;
		}
		if (!opts.canSend() || sending.value) return;
		if (await opts.seal().blockSend(sendOpts)) return;
		if (guards.blockSend(sendOpts)) return;
		if (staleGuard.blockSend(sendOpts)) return;
		sending.value = true;
		try {
			// `send()` throws on a backend reject, already toasted by the operation
			// module (SurfacedOperationError): stay put and do not report `sent`.
			await opts.send(sendOpts);
			opts.onSent({ scheduled: sendOpts?.scheduledSendAt !== undefined });
		} catch (err) {
			// Anything not already surfaced (the draft row could not be created, a
			// throw from the flush before it) gets a toast of its own.
			showOperationError(err);
		} finally {
			sending.value = false;
		}
	}

	return {
		sending,
		handleSend,
		guards,
		// `reactive` so the template reads (and v-models) the dialog state directly.
		stale: reactive({
			byName: staleGuard.staleReplyByName,
			confirmOpen: staleGuard.confirmOpen,
			confirm: staleGuard.confirm,
		}),
	};
}
