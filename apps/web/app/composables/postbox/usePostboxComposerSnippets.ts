/**
 * The Postbox composer's saved replies: the list {@link PostboxBasicEditor}'s
 * `;` trigger offers, what their variables resolve to at insert time, the
 * footer picker and the palette rows (`useComposerSavedReplyPicker`), and what
 * follows an insert.
 *
 * The variable context is everything the composer knows and a saved reply
 * cannot: who the mail is going to (from the address book, with the address
 * itself known even for a stranger), who is writing and as which identity, the
 * thread's subject, and today's date in the reader's locale. A `prompt`
 * variable has no context source (the picker asks the person instead), and
 * anything still unresolved becomes a `[[...]]` gap.
 *
 * After an insert the reply is counted (the picker's order) and, when the
 * text now holds a gap, the draft is marked gap-guarded: Send is held until
 * every gap is filled, here and on the server, also after a reload.
 *
 * Extracted out of `PostboxComposer.vue` to keep that SFC under the file-size
 * ratchet; the pure trigger/rank logic lives in `~/utils/postboxSnippets`, the
 * variable resolution in `~/utils/postboxSnippetVariables`, and the in-text
 * picker in `usePostboxSnippetPicker`. Not AI, not feature-gated beyond the
 * composer itself — it is simply inert while the list is empty.
 */

import { computed, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { usePostboxCompose, ComposerSeed } from '~/composables/postbox/usePostboxCompose';
import { usePostboxContacts } from '~/composables/postbox/usePostboxContacts';
import type { SnippetInsertOptions } from '~/composables/postbox/usePostboxSnippetPicker';
import type { BasicEditorHandle } from '~/composables/postbox/usePostboxComposerAnswerFrame';
import { useComposerSavedReplies } from '~/composables/useSavedReplies';
import { useComposerSavedReplyPicker } from '~/composables/useComposerSavedReplyPicker';
import { splitAnswerBody } from '~/utils/answerDraft';
import { firstNameOf, lastNameOf, threadSubjectOf } from '~/utils/postboxSnippets';
import {
	snippetVariableSourceKey,
	type SnippetVariableContext,
} from '~/utils/postboxSnippetVariables';
import { extractEmailAddress } from '~/utils/emailAddress';

type Compose = ReturnType<typeof usePostboxCompose>;

export function usePostboxComposerSnippets(
	seed: ComposerSeed,
	compose: Pick<
		Compose,
		| 'toAddresses'
		| 'subject'
		| 'bodyHtml'
		| 'fromAddress'
		| 'availableIdentities'
		| 'composerMode'
		| 'bodyPending'
		| 'isScheduled'
		| 'isGapGuarded'
		| 'flush'
	>,
	view: {
		rootEl: Ref<HTMLElement | null>;
		basicEditor: Ref<BasicEditorHandle | null>;
	}
) {
	const { t, locale } = useI18n();
	const { user } = useAuth();
	const mailboxRef = computed(() => seed.mailboxId ?? null);
	const { replies, recordUse } = useComposerSavedReplies(() => mailboxRef.value);

	// The draft's first To recipient, looked up in the address book. A recipient
	// who isn't a contact still has an address; their name becomes a gap rather
	// than an invented one.
	const { contacts } = usePostboxContacts(mailboxRef);
	const recipientEmail = computed(() => {
		const first = compose.toAddresses.value[0];
		return first ? extractEmailAddress(first) : null;
	});
	const recipientContact = computed(() => {
		const email = recipientEmail.value;
		return email ? (contacts.value.find((c) => c.email.toLowerCase() === email) ?? null) : null;
	});

	const variableContext = computed<SnippetVariableContext>(() => {
		const contact = recipientContact.value;
		const identity = compose.availableIdentities.value.find(
			(i) => i.address === compose.fromAddress.value
		);
		const me = user.value?.name?.trim() || null;
		return {
			recipientFirstName: firstNameOf(contact?.displayName) ?? null,
			recipientLastName: lastNameOf(contact?.displayName) ?? null,
			recipientFullName: contact?.displayName ?? null,
			recipientEmail: recipientEmail.value,
			// `organization` is the address book's own field name for it.
			recipientCompany: contact?.organization ?? null,
			senderFirstName: firstNameOf(me) ?? null,
			senderName: me ?? identity?.label ?? null,
			senderEmail: compose.fromAddress.value || null,
			threadSubject: threadSubjectOf(compose.subject.value) || null,
			// Formatted here, at the render boundary, in the reader's locale — the
			// resolver is a pure module and has no business knowing about dates.
			date: new Date().toLocaleDateString(locale.value),
		};
	});

	const guardOp = useBackendOperation(api.mail.drafts.update, {
		label: () => t('shared.postbox.usePostboxCompose.saveOperation'),
		announce: false,
	});
	/** Hold Send while the inserted gaps are open, and keep holding after a reload. */
	async function guardSend() {
		if (compose.isGapGuarded.value) return;
		compose.isGapGuarded.value = true;
		const saved = await compose.flush();
		if (saved.ok && saved.result) await guardOp.run({ draftId: saved.result, isGapGuarded: true });
	}

	const snippetInsert = computed<SnippetInsertOptions>(() => ({
		variableContext: variableContext.value,
		gapLabel: (token, source) =>
			source && source !== 'prompt' ? t(snippetVariableSourceKey(source)) : token,
		onInserted: (snippet, resolved) => {
			recordUse(snippet._id);
			if (resolved.hasGaps) void guardSend();
		},
	}));

	const footer = useComposerSavedReplyPicker({
		rootEl: view.rootEl,
		replies,
		// The picker and the palette need the simple editor, with a body loaded.
		enabled: () =>
			compose.composerMode.value === 'simple' &&
			!compose.bodyPending.value &&
			!compose.isScheduled.value,
		// "Save as reply" keeps what was written, without signature or quote.
		currentBodyHtml: () => splitAnswerBody(compose.bodyHtml.value).fresh,
		insert: (reply) => view.basicEditor.value?.insertSnippet(reply),
	});

	return { editorSnippets: replies, snippetInsert, footer };
}
