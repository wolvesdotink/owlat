/**
 * Rule suggestions from observed triage (idea 27) — the reader-footer feed.
 *
 * Reads `mail.triageTally.forMessage` for the open message's sender and exposes
 * the three verbs the strip offers: accept (create the filter), dismiss (retire
 * the offer) and undo (delete the filter accepting created). Every one of them
 * is explicit; nothing here ever applies on its own.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { postboxTriageVerbCopy, type PostboxTriageVerb } from '~/utils/postboxTriageSuggestion';

export function usePostboxTriageSuggestion(messageId: Ref<Id<'mailMessages'> | null>) {
	const { t } = useI18n();

	const { data } = useConvexQuery(api.mail.triageTally.forMessage, () =>
		messageId.value ? { messageId: messageId.value } : 'skip'
	);

	const senderAddress = computed(() => data.value?.senderAddress ?? '');
	const suggestion = computed(() => data.value?.suggestion ?? null);
	const accepted = computed(() => data.value?.accepted ?? null);

	const acceptOp = useBackendOperation(api.mail.triageTally.acceptSuggestion, {
		label: () => t('shared.postbox.usePostboxTriageSuggestion.createRule'),
	});
	const dismissOp = useBackendOperation(api.mail.triageTally.dismissSuggestion, {
		label: () => t('shared.postbox.usePostboxTriageSuggestion.dismissSuggestion'),
	});
	const undoOp = useBackendOperation(api.mail.triageTally.undoSuggestion, {
		label: () => t('shared.postbox.usePostboxTriageSuggestion.undoRule'),
	});

	async function accept() {
		const mailboxId = data.value?.mailboxId;
		const offer = suggestion.value;
		if (!mailboxId || !offer) return;
		const copy = postboxTriageVerbCopy(offer.verb);
		if (!copy) return;
		await acceptOp.run({
			mailboxId,
			senderAddress: senderAddress.value,
			verb: offer.verb as PostboxTriageVerb,
			// The rule's name is composed HERE, in the reader's language — the
			// backend has no locale, and a filter list full of English names in a
			// German account is exactly what the i18n boundary exists to prevent.
			name: t(copy.ruleNameKey, { sender: senderAddress.value }),
		});
	}

	async function dismiss() {
		const mailboxId = data.value?.mailboxId;
		const offer = suggestion.value;
		if (!mailboxId || !offer) return;
		await dismissOp.run({
			mailboxId,
			senderAddress: senderAddress.value,
			verb: offer.verb as PostboxTriageVerb,
		});
	}

	async function undo() {
		const mailboxId = data.value?.mailboxId;
		const done = accepted.value;
		if (!mailboxId || !done) return;
		await undoOp.run({
			mailboxId,
			senderAddress: senderAddress.value,
			verb: done.verb as PostboxTriageVerb,
		});
	}

	return {
		senderAddress,
		suggestion,
		accepted,
		accept,
		dismiss,
		undo,
		isBusy: computed(
			() => acceptOp.isLoading.value || dismissOp.isLoading.value || undoOp.isLoading.value
		),
	};
}
