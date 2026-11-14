import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The sender a transactional email resolves to (its own, the transactional or
 * the default sender), as `transactional.sender.get` resolves it for real
 * sends, or `null` while none is configured or it is loading.
 */
export function useResolvedTransactionalSender(emailId: {
	readonly value: Id<'transactionalEmails'>;
}) {
	const { data } = useOrganizationQuery(api.transactional.sender.get, () => ({
		templateId: emailId.value,
	}));
	return computed(() => {
		const resolved = data.value?.resolved;
		return resolved?.address ? { email: resolved.address, name: resolved.name } : null;
	});
}
