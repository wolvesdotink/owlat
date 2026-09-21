/**
 * Composer-side snippet glue: maps the per-mailbox snippet list into the shape
 * {@link PostboxBasicEditor} consumes, and assembles the context its typed
 * variables resolve against at insert time (plan idea 13).
 *
 * The context is everything the composer knows and a saved snippet cannot: who
 * the mail is going to (first name, full name, company, from the address book),
 * who it is going out as, and what today's date is in the reader's locale. A
 * `prompt` variable deliberately has no context source — the picker asks the
 * person instead — and anything still unresolved stays a visible `{{token}}`
 * for the preflight to flag beside Send.
 *
 * Extracted out of `PostboxComposer.vue` to keep that SFC under the file-size
 * ratchet; the pure trigger/rank logic lives in `~/utils/postboxSnippets`, the
 * variable resolution in `~/utils/postboxSnippetVariables`, and the picker
 * controller in `usePostboxSnippetPicker`. Not AI, not feature-gated — the
 * picker is simply inert when the snippet list is empty.
 */

import { computed } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxSnippets } from '~/composables/postbox/usePostboxSnippets';
import { usePostboxContacts } from '~/composables/postbox/usePostboxContacts';
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';
import { firstNameOf } from '~/utils/postboxSnippets';
import type { SnippetVariable, SnippetVariableContext } from '~/utils/postboxSnippetVariables';
import { extractEmailAddress } from '~/utils/emailAddress';

export function usePostboxComposerSnippets(
	mailboxId: () => Id<'mailboxes'> | null,
	firstToAddress: () => string | undefined,
	sender: () => { name?: string | null; email?: string | null } = () => ({})
) {
	const { locale } = useI18n();
	const mailboxRef = computed(() => mailboxId());
	const { snippets } = usePostboxSnippets(mailboxRef);
	const editorSnippets = computed<EditorSnippet[]>(() =>
		snippets.value.map((s) => ({
			_id: s._id,
			name: s.name,
			shortcut: s.shortcut,
			bodyHtml: s.bodyHtml,
			// Absent on every snippet saved before idea 13; the resolver then falls
			// back to the implicit token table, so `{{firstName}}` keeps working.
			variables: (s.variables ?? undefined) as SnippetVariable[] | undefined,
		}))
	);

	// The draft's first To recipient, looked up in the address book. A recipient
	// who isn't a contact simply has no facts, which leaves their tokens standing
	// rather than inventing a name.
	const { contacts } = usePostboxContacts(mailboxRef);
	const recipientContact = computed(() => {
		const first = firstToAddress();
		if (!first) return null;
		const email = extractEmailAddress(first);
		return contacts.value.find((c) => c.email.toLowerCase() === email) ?? null;
	});

	const snippetVariableContext = computed<SnippetVariableContext>(() => {
		const contact = recipientContact.value;
		const identity = sender();
		return {
			recipientFirstName: firstNameOf(contact?.displayName) ?? null,
			recipientFullName: contact?.displayName ?? null,
			// `organization` is the address book's own field name for it.
			recipientCompany: contact?.organization ?? null,
			senderName: identity.name ?? null,
			senderEmail: identity.email ?? null,
			// Formatted here, at the render boundary, in the reader's locale — the
			// resolver is a pure module and has no business knowing about dates.
			date: new Date().toLocaleDateString(locale.value),
		};
	});

	return { editorSnippets, snippetVariableContext };
}
