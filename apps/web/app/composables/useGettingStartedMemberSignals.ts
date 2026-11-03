import { api } from '@owlat/api';
import { computed, type ComputedRef } from 'vue';
import type { ChecklistAudience } from '~/utils/welcomeFlow';

/**
 * The member's own Getting started steps, read from real state rather than
 * stamps: the mailbox's display name, whether it has a signature, and the
 * notification setting. These are the same records the welcome form writes.
 * An admin viewer's checklist has none of these steps, so nothing is read.
 */
export function useGettingStartedMemberSignals(audience: ComputedRef<ChecklistAudience>) {
	const { currentMailbox, isLoading: isLoadingMailbox } = usePostboxMailbox();
	const { data: signatures, isLoading: isLoadingSignatures } = useConvexQuery(
		api.mail.signatures.list,
		() => {
			const mailbox = currentMailbox.value;
			return audience.value === 'member' && mailbox ? { mailboxId: mailbox._id } : 'skip';
		}
	);
	const { data: mailSettings, isLoading: isLoadingMailSettings } = useConvexQuery(
		api.mail.settings.get,
		() => (audience.value === 'member' ? {} : 'skip')
	);
	const isLoading = computed(
		() =>
			audience.value === 'member' &&
			(isLoadingMailbox.value ||
				(currentMailbox.value !== null && isLoadingSignatures.value) ||
				isLoadingMailSettings.value)
	);
	return { currentMailbox, signatures, mailSettings, isLoading };
}
