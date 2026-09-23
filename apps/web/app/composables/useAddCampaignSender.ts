import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail } from '@owlat/shared';
import { mapSenderVerification } from '~/utils/campaignSenderVerification';

/**
 * Adding a campaign sender: the address and display name being typed, the
 * verified-domain advisory for that address, and the create call.
 *
 * Settings → Campaign senders and the campaign wizard's inline "Add a sender"
 * (#785) are the same add path, so they share this rather than each carrying a
 * copy of the query, the advisory and the mutation.
 */
export function useAddCampaignSender(options: { operationLabel: () => string }) {
	const { t } = useI18n();

	const email = ref('');
	const displayName = ref('');
	const addError = ref<string | null>(null);

	const { run: createSender, isLoading: creating } = useBackendOperation(
		api.campaigns.senders.create,
		{ label: options.operationLabel, inlineTarget: addError }
	);

	const hasValidEmail = computed(() => isValidEmail(email.value.trim()));

	const { data: domainStatus, error: domainStatusError } = useOrganizationQuery(
		api.domains.domains.getEmailDomainVerificationStatus,
		() => {
			const value = email.value.trim();
			if (!value || !isValidEmail(value)) return undefined;
			return { email: value };
		}
	);

	const verification = computed(() =>
		mapSenderVerification(domainStatus.value, hasValidEmail.value, domainStatusError.value != null)
	);

	// The shared advisory carries message KEYS (with params when the copy names
	// the domain), never sentences.
	const verificationMessage = computed(() => {
		const message = verification.value.message;
		return typeof message === 'string' ? t(message) : t(message.key, message.params ?? {});
	});

	function reset() {
		email.value = '';
		displayName.value = '';
		addError.value = null;
	}

	/** Create the sender; resolves its id, or `null` when nothing was added. */
	async function add(): Promise<Id<'campaignSenders'> | null> {
		addError.value = null;
		if (creating.value || !verification.value.canAdd) return null;
		const result = await createSender({
			email: email.value.trim(),
			displayName: displayName.value.trim() || undefined,
		});
		return result.ok ? result.result : null;
	}

	return {
		email,
		displayName,
		addError,
		creating,
		verification,
		verificationMessage,
		reset,
		add,
	};
}
