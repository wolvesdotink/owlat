/**
 * Ask your mailbox, in the command palette: `?` typed in Postbox's Mail scope
 * answers the question from the person's own mail, with numbered citations
 * that each open the message they point at.
 *
 * The backend (`mail/ai/askMailbox.askMailbox`) decides which mailboxes are
 * read and asserts the `ai` flag; the palette only offers the prompt while that
 * flag is on.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** A message the answer cites; `index` is the `[n]` marker in the answer text. */
export interface MailAskCitation {
	index: number;
	messageId: Id<'mailMessages'>;
	mailboxId: Id<'mailboxes'>;
	folderId: Id<'mailFolders'>;
	threadId: Id<'mailThreads'>;
	subject: string;
	from: string;
	date: number;
}

export interface MailAskAnswer {
	/** '' when no message matched the question. */
	answer: string;
	citations: MailAskCitation[];
	/** False: at least one mailbox was read from headers and snippets only. */
	bodySearchUsed: boolean;
	isTruncated: boolean;
}

/**
 * The Postbox route of a cited message. The route takes a folder id as well as
 * a system-folder role, and the citation carries the id, so no folder read is
 * needed.
 */
export function mailAskCitationPath(citation: Pick<MailAskCitation, 'folderId' | 'messageId'>) {
	return `/dashboard/postbox/${citation.folderId}/${citation.messageId}`;
}

export function useCommandPaletteMailAsk(options: { onNavigate: () => void }) {
	const { t } = useI18n();
	const { setActiveMailboxId } = usePostboxActiveMailbox();
	const { run, isLoading } = useBackendOperation(api.mail.ai.askMailbox.askMailbox, {
		label: () => t('components.appCommandPalette.mailAsk.operation'),
		type: 'action',
	});

	const answer = ref<MailAskAnswer | null>(null);
	/** The question the on-screen answer belongs to. */
	const askedQuestion = ref('');

	async function ask(question: string) {
		const trimmed = question.trim();
		if (!trimmed || isLoading.value) return;
		answer.value = null;
		askedQuestion.value = trimmed;
		const response = await run({ question: trimmed });
		if (!response?.ok) return;
		answer.value = (response.result as MailAskAnswer | undefined) ?? null;
	}

	/** Open a cited message: a team inbox's message needs its mailbox selected first. */
	function openCitation(citation: MailAskCitation) {
		options.onNavigate();
		setActiveMailboxId(citation.mailboxId);
		void navigateTo({ path: mailAskCitationPath(citation) });
	}

	function reset() {
		answer.value = null;
		askedQuestion.value = '';
	}

	return { ask, reset, openCitation, answer, askedQuestion, isLoading };
}
