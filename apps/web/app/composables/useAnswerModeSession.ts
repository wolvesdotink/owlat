/**
 * What Answer mode opens its composer with, decided from the URL alone so a
 * reload lands in the same state (plan decision 1):
 *
 *  - `?draft=<id>` resumes that draft (the seed carries only the id; the
 *    composer hydrates everything else from the row);
 *  - otherwise a fresh composer of `?kind=`, or of the person's primary reply
 *    kind when the URL names none. A reply and a reply-all first pass the
 *    sender-auth reply guard (a deep link never went through the reader's);
 *    forward never does. The seed is built once the message and the
 *    mailbox's own addresses (for the reply-all recipient math) are known.
 *
 * The draft id is not created here: the composer creates the row with its
 * first autosave and the page writes it into the URL then, so opening Answer
 * mode and leaving without a keystroke leaves no empty draft behind.
 */
import type { ShallowRef } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractEmailAddress } from '~/utils/emailAddress';
import type { AnswerModeKind } from '~/utils/answerMode';
import {
	buildReplyComposeSeed,
	primaryReplyKindFor,
	type ReplyComposeSeed,
	type ReplyForwardSource,
} from '~/composables/postbox/postboxReplySpec';
import { useAnswerPendingLead } from './useAnswerMode';

export type AnswerModeMessage = ReplyForwardSource & { mailboxId: string; threadId?: string };

export function useAnswerModeSession(opts: {
	message: () => AnswerModeMessage | undefined;
	/** `?draft=` as the page opened; fixed for the life of the session. */
	draftId: string | null;
	/** `?kind=` as the page opened. */
	kind: AnswerModeKind | null;
	/** Run the reply guard for `message`, then `proceed` (or never, on cancel). */
	guard: (message: AnswerModeMessage, proceed: () => void) => void;
}) {
	const ownQuery = useConvexQuery(api.mail.identities.listForOwnedMailbox, () => {
		const message = opts.message();
		return message ? { mailboxId: message.mailboxId as Id<'mailboxes'> } : 'skip';
	});
	const ownAddresses = computed(
		() => new Set(((ownQuery.data.value as string[] | undefined) ?? []).map(extractEmailAddress))
	);
	const { replyDefault } = usePostboxSettings();
	const pendingLead = useAnswerPendingLead();

	const seed: ShallowRef<ReplyComposeSeed | null> = shallowRef(null);
	/** The composer kind in use; null for a resumed draft whose URL named none. */
	const kind = ref<AnswerModeKind | null>(opts.kind);
	let started = false;

	async function buildFresh(message: AnswerModeMessage, resolved: AnswerModeKind) {
		seed.value = await buildReplyComposeSeed(resolved, message, {
			mailboxId: message.mailboxId as Id<'mailboxes'>,
			ownAddresses: ownAddresses.value,
			leadText: pendingLead.take(message._id),
		});
	}

	watch(
		[opts.message, () => ownQuery.data.value, () => ownQuery.error.value] as const,
		([message, own, ownError]) => {
			if (started || !message) return;
			if (opts.draftId) {
				started = true;
				seed.value = {
					mailboxId: message.mailboxId as Id<'mailboxes'>,
					draftId: opts.draftId as Id<'mailDrafts'>,
					...(opts.kind === 'forward'
						? {}
						: { inReplyToMessageId: message._id as Id<'mailMessages'> }),
				};
				return;
			}
			// The reply-all math needs the mailbox's own addresses; a failed read
			// degrades to "no one is us" rather than never opening.
			if (own === undefined && !ownError) return;
			started = true;
			const resolved =
				opts.kind ?? primaryReplyKindFor(replyDefault.value, message, ownAddresses.value);
			kind.value = resolved;
			if (resolved === 'forward') void buildFresh(message, resolved);
			else opts.guard(message, () => void buildFresh(message, resolved));
		},
		{ immediate: true }
	);

	return { seed, kind };
}
