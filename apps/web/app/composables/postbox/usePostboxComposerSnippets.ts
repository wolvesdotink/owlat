/**
 * Composer-side snippet glue: maps the per-mailbox snippet list into the shape
 * {@link PostboxBasicEditor} consumes, and resolves the `{{firstName}}`
 * placeholder from the draft's first To recipient via the address book.
 *
 * Extracted out of `PostboxComposer.vue` to keep that SFC under the file-size
 * ratchet; the pure trigger/rank/placeholder logic lives in
 * `~/utils/postboxSnippets`, and the picker controller in
 * `usePostboxSnippetPicker`. Not AI, not feature-gated — the picker is simply
 * inert when the snippet list is empty.
 */

import { computed } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxSnippets } from '~/composables/postbox/usePostboxSnippets';
import { usePostboxContacts } from '~/composables/postbox/usePostboxContacts';
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';
import { firstNameOf } from '~/utils/postboxSnippets';
import { extractEmailAddress } from '~/utils/emailAddress';

export function usePostboxComposerSnippets(
	mailboxId: () => Id<'mailboxes'> | null,
	firstToAddress: () => string | undefined
) {
	const mailboxRef = computed(() => mailboxId());
	const { snippets } = usePostboxSnippets(mailboxRef);
	const editorSnippets = computed<EditorSnippet[]>(() =>
		snippets.value.map((s) => ({
			_id: s._id,
			name: s.name,
			shortcut: s.shortcut,
			bodyHtml: s.bodyHtml,
		}))
	);

	// Resolve `{{firstName}}` from the draft's first To recipient via the address
	// book (falls back to a visible token when the recipient isn't a contact).
	const { contacts } = usePostboxContacts(mailboxRef);
	const snippetFirstName = computed(() => {
		const first = firstToAddress();
		if (!first) return undefined;
		const email = extractEmailAddress(first);
		const contact = contacts.value.find((c) => c.email.toLowerCase() === email);
		return firstNameOf(contact?.displayName);
	});

	return { editorSnippets, snippetFirstName };
}
