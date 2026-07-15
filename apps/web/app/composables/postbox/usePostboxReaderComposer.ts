import type { ComputedRef, Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { extractEmailAddress } from '~/utils/emailAddress';
import { deriveReplyAllExtras } from '~/utils/recipientHints';
import { resolvePrimaryReplyKind, type PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import type { PostboxPendingCompose } from '~/utils/postboxShortcuts';
import type {
	ComposerSpec,
	InlineComposeKind,
	InlineComposeSpec,
} from '~/composables/postbox/usePostboxComposerStack';

/** The reply/forward source shape the composer quotes from. */
export type ReplyForwardSource = {
	_id: string;
	subject: string;
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	receivedAt: number;
	htmlBodyInline?: string;
	textBodyInline?: string;
};

/** The open reader message — a reply source plus the routing/identity fields. */
type ReaderComposerMessage = ReplyForwardSource & { mailboxId: string; threadId?: string };

/**
 * The reply / reply-all / forward composer concerns of the thread reader:
 * popup openers, the pinned inline reply box, and the list→reader r/a/f
 * hand-off. Extracted from PostboxThreadReader.vue so both the reader shell and
 * this compose layer stay independently readable; behavior is unchanged.
 *
 * `getMessage` returns the currently open message; `latestMessage` /
 * `ownAddresses` / `replyDefault` are the reader's live derived state, passed in
 * rather than re-derived so this composable is a pure view over them.
 *
 * `guardReply` (optional) wraps a reply/reply-all action with the sender-auth
 * reply guard (Sealed Mail A3): the reader supplies it, and EVERY reply /
 * reply-all entry point that lives in this layer — the keyboard `r`/`a`, the
 * pinned inline box, and the list→reader hand-off — is routed through it so the
 * interstitial can't be side-stepped by a non-button path. Forward is never
 * guarded. Defaults to running the action directly (flag off / no guard).
 */
export function usePostboxReaderComposer(opts: {
	getMessage: () => ReaderComposerMessage;
	latestMessage: ComputedRef<ReplyForwardSource | undefined>;
	ownAddresses: ComputedRef<Set<string>>;
	replyDefault: Ref<PostboxReplyDefaultMode> | ComputedRef<PostboxReplyDefaultMode>;
	guardReply?: (run: () => void) => void;
}) {
	const { getMessage, latestMessage, ownAddresses, replyDefault } = opts;
	const guardReply = opts.guardReply ?? ((run: () => void) => run());
	const stack = usePostboxComposerStack();

	/**
	 * Build the one-time compose seed for a reply / reply-all / forward of
	 * `source` — shared by the popup openers below and the inline reply box, so
	 * both paths produce identical drafts (quoting, recipients, subject prefix).
	 */
	async function buildComposeSpec(
		kind: InlineComposeKind,
		source: ReplyForwardSource
	): Promise<Omit<ComposerSpec, 'id' | 'minimized'>> {
		const target = await resolveBodyFields(source);
		const mailboxId = getMessage().mailboxId as Id<'mailboxes'>;
		if (kind === 'forward') {
			return {
				mailboxId,
				prefillSubject: target.subject.match(/^fwd?\s*:\s*/i)
					? target.subject
					: `Fwd: ${target.subject}`,
				prefillBodyHtml: buildForwardedBody(target),
				forwardAttachmentsFromMessageId: target._id as Id<'mailMessages'>,
			};
		}
		const spec: Omit<ComposerSpec, 'id' | 'minimized'> = buildReplySpec(mailboxId, target);
		const extras = deriveReplyAllExtras(target, [...ownAddresses.value]);
		if (kind === 'replyAll') {
			spec.prefillCc = extras;
		} else if (kind === 'reply' && extras.length > 0) {
			// Surface the "Also include …?" gap hint in the composer.
			spec.replyAllRecipients = extras;
		}
		return spec;
	}

	async function openReplyAll(replyTo?: ReplyForwardSource) {
		stack.open(await buildComposeSpec('replyAll', replyTo ?? getMessage()));
	}

	/**
	 * The reply kind the PRIMARY affordance (Reply button / `r`) opens: honors the
	 * user's default-reply preference, collapsing to a plain reply when reply-all
	 * would add no one. The explicit Reply-all button / `a` bypass this.
	 */
	function primaryReplyKind(source: {
		fromAddress: string;
		toAddresses: string[];
		ccAddresses: string[];
	}): InlineComposeKind {
		return resolvePrimaryReplyKind(replyDefault.value, hasOtherRecipients(source));
	}

	/** Open the popup composer for the primary reply (per the default preference). */
	async function openPrimaryReply(replyTo?: ReplyForwardSource) {
		const source = replyTo ?? getMessage();
		stack.open(await buildComposeSpec(primaryReplyKind(source), source));
	}

	/** Whether Reply-All would add anyone beyond a plain Reply (extra To/Cc). */
	function hasOtherRecipients(msg: {
		fromAddress: string;
		toAddresses: string[];
		ccAddresses: string[];
	}) {
		const seen = new Set<string>([extractEmailAddress(msg.fromAddress), ...ownAddresses.value]);
		return [...msg.toAddresses, ...msg.ccAddresses].some((a) => {
			const c = extractEmailAddress(a);
			return c.length > 0 && !seen.has(c);
		});
	}

	/** Open a reply seeded with an AI-suggested body (above the quoted original). */
	async function openReplyWithBody(replyTarget: ReplyForwardSource, bodyText: string) {
		const target = await resolveBodyFields(replyTarget);
		stack.open(buildReplySpec(getMessage().mailboxId as Id<'mailboxes'>, target, bodyText));
	}

	async function openForward(msg?: ReplyForwardSource) {
		stack.open(await buildComposeSpec('forward', msg ?? getMessage()));
	}

	// --- Inline reply box pinned under the conversation (Spark-style). Expands
	// via the collapsed affordance or the r/a/f keys; the popup path above stays
	// for the per-message Reply/Forward buttons inside the thread. Both share
	// buildComposeSpec, so the inline draft carries the same quoted text and
	// recipients as a popup reply would.
	const inlineSpec = ref<InlineComposeSpec | null>(null);
	const inlineReplyEl = ref<{ focusEditor: () => void } | null>(null);
	let inlineSeq = 0;

	async function expandInline(kind: InlineComposeKind) {
		const target = latestMessage.value;
		if (!target) return;
		if (inlineSpec.value?.kind === kind) {
			// Already open in this mode — just re-focus it (r/a re-press).
			inlineReplyEl.value?.focusEditor();
			return;
		}
		const seq = ++inlineSeq;
		const seed = await buildComposeSpec(kind, target);
		// Superseded by a newer expand or a thread change while resolving the body.
		if (seq !== inlineSeq) return;
		inlineSpec.value = { ...seed, kind, key: `${target._id}:${kind}` };
	}

	/**
	 * Expand the inline box for the PRIMARY reply (Reply affordance / `r`): honors
	 * the default-reply preference, opening a reply-all when the user prefers it
	 * and the message actually has other recipients. The explicit `a` / Reply-all
	 * icon call expandInline('replyAll') directly and bypass this.
	 */
	async function expandPrimaryReply() {
		const target = latestMessage.value;
		if (!target) return;
		await expandInline(primaryReplyKind(target));
	}

	// Guarded inline entry points: the reply guard sees the reply BEFORE the box
	// expands. Used by the reader's keyboard shortcuts, the pinned inline box's
	// expand affordance, and the list→reader hand-off below.
	function guardedExpandReply() {
		guardReply(() => void expandPrimaryReply());
	}
	function guardedExpandReplyAll() {
		guardReply(() => void expandInline('replyAll'));
	}

	function collapseInline() {
		inlineSeq++;
		inlineSpec.value = null;
	}

	// A newly opened conversation always starts collapsed (and therefore can
	// never steal focus on thread open).
	watch(
		() => getMessage().threadId ?? getMessage()._id,
		() => collapseInline()
	);

	const inlineSenderLabel = computed(() => {
		const m = latestMessage.value;
		return m ? m.fromName || m.fromAddress : '';
	});

	// Consume a pending compose intent set by the thread list's r/a/f shortcuts:
	// the list opens the message, then we open the matching composer once this
	// reader renders it (the quoting/recipient logic lives here).
	const pendingCompose = useState<PostboxPendingCompose | null>(
		POSTBOX_PENDING_COMPOSE_KEY,
		() => null
	);
	// Watch the intent as well as the id: r/a/f on a row whose message is already
	// open never changes `message._id`. Stale intents (id changed to a
	// non-matching message) are dropped so they can't fire on a later plain open;
	// see settlePendingCompose in utils/postboxShortcuts.ts.
	watch(
		[() => getMessage()._id, pendingCompose] as const,
		([id], prev) => {
			const { open, clear } = settlePendingCompose(pendingCompose.value, id, prev?.[0]);
			if (clear) pendingCompose.value = null;
			// Reply / reply-all go through the guard (the list r/a hand-off is a
			// primary reply path too); forward is never guarded.
			if (open === 'reply') guardedExpandReply();
			else if (open === 'replyAll') guardedExpandReplyAll();
			else if (open === 'forward') void expandInline('forward');
		},
		{ immediate: true }
	);

	return {
		openReplyAll,
		openPrimaryReply,
		openReplyWithBody,
		openForward,
		hasOtherRecipients,
		inlineSpec,
		inlineReplyEl,
		expandInline,
		expandPrimaryReply,
		guardedExpandReply,
		guardedExpandReplyAll,
		collapseInline,
		inlineSenderLabel,
	};
}
