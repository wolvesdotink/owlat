/**
 * App password CRUD wrapper.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export type AppPasswordScope = 'imap' | 'smtp';

export function usePostboxAppPasswords(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.appPasswords.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);

	const passwords = computed(() => data.value ?? []);

	const generateMutation = useBackendOperation(api.mail.appPasswords.generate, {
		label: 'Generate app password',
	});
	const revokeMutation = useBackendOperation(api.mail.appPasswords.revoke, {
		label: 'Revoke app password',
	});
	const revokeAllMutation = useBackendOperation(api.mail.appPasswords.revokeAll, {
		label: 'Revoke all app passwords',
	});

	async function generate(label: string, scopes?: AppPasswordScope[]) {
		if (!mailboxId.value) throw new Error('No mailbox');
		return generateMutation.run({
			mailboxId: mailboxId.value,
			label,
			scopes,
		}) as Promise<{ id: Id<'mailAppPasswords'>; cleartext: string }>;
	}

	async function revoke(appPasswordId: Id<'mailAppPasswords'>) {
		await revokeMutation.run({ appPasswordId });
	}

	async function revokeAll() {
		if (!mailboxId.value) return;
		await revokeAllMutation.run({ mailboxId: mailboxId.value });
	}

	return {
		passwords,
		isLoading,
		generate,
		revoke,
		revokeAll,
	};
}
