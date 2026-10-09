/**
 * The thread brief's 30-day backfill of one mailbox (`mail.interpret.backfill`,
 * ADR-0072 D5): its live status, and Prepare / Resume / Stop for the owner.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useBriefBackfill(mailboxId: () => Id<'mailboxes'> | null) {
	const { t } = useI18n();
	const { data } = useConvexQuery(api.mail.interpret.backfill.status, () => {
		const id = mailboxId();
		return id ? { mailboxId: id } : 'skip';
	});
	const status = computed(() => data.value ?? null);

	const startOp = useBackendOperation(api.mail.interpret.backfill.start, {
		label: () => t('components.preferences.preferencesReading.backfillOperation'),
	});
	const cancelOp = useBackendOperation(api.mail.interpret.backfill.cancel, {
		label: () => t('components.preferences.preferencesReading.backfillCancelOperation'),
	});

	async function start() {
		const id = mailboxId();
		if (id) await startOp.run({ mailboxId: id });
	}
	async function cancel() {
		const id = mailboxId();
		if (id) await cancelOp.run({ mailboxId: id });
	}

	return { status, start, cancel, isBusy: computed(() => startOp.isLoading.value) };
}
