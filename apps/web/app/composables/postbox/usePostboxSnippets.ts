/**
 * Per-mailbox snippet (canned response) CRUD wrapper.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxSnippets(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.snippets.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const snippets = computed(() => data.value ?? []);

	const createMutation = useBackendOperation(api.mail.snippets.create, {
		label: 'Create snippet',
	});
	const updateMutation = useBackendOperation(api.mail.snippets.update, {
		label: 'Save snippet',
	});
	const removeMutation = useBackendOperation(api.mail.snippets.remove, {
		label: 'Delete snippet',
	});

	async function create(name: string, shortcut: string, bodyHtml: string) {
		if (!mailboxId.value) throw new Error('No mailbox');
		return createMutation.run({
			mailboxId: mailboxId.value,
			name,
			shortcut,
			bodyHtml,
		});
	}

	async function update(
		snippetId: Id<'mailSnippets'>,
		patch: { name?: string; shortcut?: string; bodyHtml?: string }
	) {
		await updateMutation.run({ snippetId, ...patch });
	}

	async function remove(snippetId: Id<'mailSnippets'>) {
		await removeMutation.run({ snippetId });
	}

	return { snippets, isLoading, create, update, remove };
}
