/**
 * Per-mailbox snippet (canned response) CRUD wrapper.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { SnippetVariable } from '~/utils/postboxSnippetVariables';

export function usePostboxSnippets(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { data, isLoading } = useConvexQuery(api.mail.snippets.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const snippets = computed(() => data.value ?? []);

	const createMutation = useBackendOperation(api.mail.snippets.create, {
		label: () => t('shared.postbox.usePostboxSnippets.createSnippet'),
	});
	const updateMutation = useBackendOperation(api.mail.snippets.update, {
		label: () => t('shared.postbox.usePostboxSnippets.saveSnippet'),
	});
	const removeMutation = useBackendOperation(api.mail.snippets.remove, {
		label: () => t('shared.postbox.usePostboxSnippets.deleteSnippet'),
	});

	async function create(
		name: string,
		shortcut: string,
		bodyHtml: string,
		variables?: SnippetVariable[]
	) {
		if (!mailboxId.value) throw new Error('No mailbox');
		return createMutation.run({
			mailboxId: mailboxId.value,
			name,
			shortcut,
			bodyHtml,
			variables,
		});
	}

	async function update(
		snippetId: Id<'mailSnippets'>,
		patch: { name?: string; shortcut?: string; bodyHtml?: string; variables?: SnippetVariable[] }
	) {
		await updateMutation.run({ snippetId, ...patch });
	}

	async function remove(snippetId: Id<'mailSnippets'>) {
		await removeMutation.run({ snippetId });
	}

	return { snippets, isLoading, create, update, remove };
}
