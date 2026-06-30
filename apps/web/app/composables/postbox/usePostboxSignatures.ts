/**
 * Per-mailbox signature CRUD wrapper.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxSignatures(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.signatures.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const signatures = computed(() => data.value ?? []);

	const defaultQuery = useConvexQuery(api.mail.signatures.getDefault, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const defaultSignature = computed(() => defaultQuery.data.value ?? null);

	const createMutation = useBackendOperation(api.mail.signatures.create, {
		label: 'Create signature',
	});
	const updateMutation = useBackendOperation(api.mail.signatures.update, {
		label: 'Save signature',
	});
	const removeMutation = useBackendOperation(api.mail.signatures.remove, {
		label: 'Delete signature',
	});

	async function create(name: string, html: string, isDefault?: boolean) {
		if (!mailboxId.value) throw new Error('No mailbox');
		return createMutation.run({ mailboxId: mailboxId.value, name, html, isDefault });
	}

	async function update(
		signatureId: Id<'mailSignatures'>,
		patch: { name?: string; html?: string; isDefault?: boolean }
	) {
		await updateMutation.run({ signatureId, ...patch });
	}

	async function remove(signatureId: Id<'mailSignatures'>) {
		await removeMutation.run({ signatureId });
	}

	return { signatures, defaultSignature, isLoading, create, update, remove };
}
