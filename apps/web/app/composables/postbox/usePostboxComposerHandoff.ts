/**
 * How a composer hands its draft to the page around it:
 *
 *  - the draft id, emitted as soon as the row exists (created by the first
 *    autosave, or reopened), so Answer mode and the compose page can write it
 *    into their URL;
 *  - discard, then tell the host;
 *  - what the host reads as it leaves: the row, who it is for, whether it
 *    holds anything, and (for the compose page, which parks it when it closes
 *    before the text is confirmed saved) everything on screen as a seed that
 *    would reopen it.
 */
import { watch, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { answerDraftHasContent } from '~/utils/answerMode';
import type { ComposerSeed } from './usePostboxCompose';
import type { ComposerAttachment } from './usePostboxComposeAttachments';

export function usePostboxComposerHandoff(opts: {
	seed: ComposerSeed;
	draftId: Readonly<Ref<Id<'mailDrafts'> | null | undefined>>;
	toAddresses: Readonly<Ref<string[]>>;
	ccAddresses: Readonly<Ref<string[]>>;
	bccAddresses: Readonly<Ref<string[]>>;
	subject: Readonly<Ref<string>>;
	bodyHtml: Readonly<Ref<string>>;
	attachments: Readonly<Ref<ComposerAttachment[]>>;
	discard: () => Promise<unknown>;
	emitDiscarded: () => void;
	emitDraftId: (draftId: Id<'mailDrafts'>) => void;
}) {
	watch(
		opts.draftId,
		(id) => {
			if (id) opts.emitDraftId(id);
		},
		{ immediate: true }
	);

	async function handleDiscard() {
		await opts.discard();
		opts.emitDiscarded();
	}

	const snapshot = () => ({
		draftId: opts.draftId.value ?? null,
		toAddresses: [...opts.toAddresses.value],
		hasContent: answerDraftHasContent(opts.bodyHtml.value, opts.attachments.value.length),
	});

	/** Committed attachments only; an upload still in flight has nothing to replay. */
	function composition(): ComposerSeed {
		const draftId = opts.draftId.value;
		return {
			mailboxId: opts.seed.mailboxId,
			...(draftId ? { draftId } : {}),
			...(opts.seed.inReplyToMessageId ? { inReplyToMessageId: opts.seed.inReplyToMessageId } : {}),
			prefillTo: [...opts.toAddresses.value],
			prefillCc: [...opts.ccAddresses.value],
			prefillBcc: [...opts.bccAddresses.value],
			prefillSubject: opts.subject.value,
			prefillBodyHtml: opts.bodyHtml.value,
			...(opts.attachments.value.length > 0
				? { prefillAttachments: [...opts.attachments.value] }
				: {}),
		};
	}

	return { handleDiscard, snapshot, composition };
}
