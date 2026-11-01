/**
 * The email the translation manager edits, for either surface: the read, and
 * the three translation writes (add a language, save a language's overlay,
 * remove a language). Marketing templates and transactional emails keep their
 * translations behind different functions with differently named ids; this is
 * the one place that tells them apart.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { TranslationUpdatePayload } from '~/composables/translationSave';
import type { TranslationCommitResult } from '~/composables/useTranslationDrafts';

export type TranslationEmailType = 'marketing' | 'transactional';

/** The add-language write: the backend seeds the overlay, the HTML lands with it. */
interface LanguageAddWrite {
	language: string;
	htmlContent: string;
	rendererVersion: number;
	expectedContentRevision: number;
}

interface LanguageRemoveWrite {
	language: string;
	expectedContentRevision: number;
}

export function useTranslationEmail(props: {
	readonly emailId: string;
	readonly emailType: TranslationEmailType;
}) {
	const { t } = useI18n();

	// Fetch email data based on type
	const {
		data: marketingEmail,
		isLoading: marketingLoading,
		error: marketingError,
		refetch: refetchMarketing,
	} = useConvexQuery(api.emailTemplates.emails.get, () => {
		if (props.emailType !== 'marketing') return 'skip';
		return { templateId: props.emailId as Id<'emailTemplates'> };
	});

	const {
		data: transactionalEmail,
		isLoading: transactionalLoading,
		error: transactionalError,
		refetch: refetchTransactional,
	} = useConvexQuery(api.transactional.emails.get, () => {
		if (props.emailType !== 'transactional') return 'skip';
		return { id: props.emailId as Id<'transactionalEmails'> };
	});

	// Unified email object
	const email = computed(() => {
		if (props.emailType === 'marketing') return marketingEmail.value;
		return transactionalEmail.value;
	});

	const isLoading = computed(() => {
		if (props.emailType === 'marketing') return marketingLoading.value;
		return transactionalLoading.value;
	});

	// A failed read is not a missing email: the manager shows its error, not "not found".
	const emailError = computed(() =>
		props.emailType === 'marketing' ? marketingError.value : transactionalError.value
	);
	const refetchEmail = () =>
		props.emailType === 'marketing' ? refetchMarketing() : refetchTransactional();

	// Mutations
	const { run: addMarketingTranslation } = useBackendOperation(
		api.emailTemplates.i18n.addTranslation,
		{ label: () => t('components.translation.manager.addLanguageOperation') }
	);
	const { run: updateMarketingTranslation } = useBackendOperation(
		api.emailTemplates.i18n.updateTranslation,
		{ label: () => t('components.translation.manager.saveTranslationOperation') }
	);
	const { run: removeMarketingTranslation } = useBackendOperation(
		api.emailTemplates.i18n.removeTranslation,
		{ label: () => t('components.translation.manager.removeLanguageOperation') }
	);

	const { run: addTransactionalTranslation } = useBackendOperation(
		api.transactional.translations.addTranslation,
		{ label: () => t('components.translation.manager.addLanguageOperation') }
	);
	const { run: updateTransactionalTranslation } = useBackendOperation(
		api.transactional.translations.updateTranslation,
		{ label: () => t('components.translation.manager.saveTranslationOperation') }
	);
	const { run: removeTransactionalTranslation } = useBackendOperation(
		api.transactional.translations.removeTranslation,
		{ label: () => t('components.translation.manager.removeLanguageOperation') }
	);

	// The transactional write takes no preview text, so its fields are named.
	const updateTranslation = async (
		payload: TranslationUpdatePayload
	): Promise<TranslationCommitResult> => {
		const saved =
			props.emailType === 'marketing'
				? await updateMarketingTranslation({
						templateId: props.emailId as Id<'emailTemplates'>,
						...payload,
					})
				: await updateTransactionalTranslation({
						id: props.emailId as Id<'transactionalEmails'>,
						language: payload.language,
						subject: payload.subject,
						blocks: payload.blocks,
						htmlContent: payload.htmlContent,
						rendererVersion: payload.rendererVersion,
						expectedContentRevision: payload.expectedContentRevision,
					});
		return saved.ok ? { ok: true, revision: saved.result.contentRevision } : { ok: false };
	};

	const addTranslation = async (write: LanguageAddWrite): Promise<TranslationCommitResult> => {
		const result =
			props.emailType === 'marketing'
				? await addMarketingTranslation({
						templateId: props.emailId as Id<'emailTemplates'>,
						...write,
					})
				: await addTransactionalTranslation({
						id: props.emailId as Id<'transactionalEmails'>,
						...write,
					});
		return result.ok ? { ok: true, revision: result.result.contentRevision } : { ok: false };
	};

	// The backend drops the language's HTML with its overlay.
	const removeTranslation = async (
		write: LanguageRemoveWrite
	): Promise<TranslationCommitResult> => {
		const result =
			props.emailType === 'marketing'
				? await removeMarketingTranslation({
						templateId: props.emailId as Id<'emailTemplates'>,
						...write,
					})
				: await removeTransactionalTranslation({
						id: props.emailId as Id<'transactionalEmails'>,
						...write,
					});
		return result.ok ? { ok: true, revision: result.result.contentRevision } : { ok: false };
	};

	return {
		email,
		isLoading,
		emailError,
		refetchEmail,
		updateTranslation,
		addTranslation,
		removeTranslation,
	};
}
