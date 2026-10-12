/**
 * The language and embedding keys of the AI-provider form: whether a stored
 * key still applies, and the inline error each key field shows.
 *
 * A stored key counts only while its plane keeps the same provider kind and
 * base URL; a save across either change needs a new key, and the server
 * refuses one without it (`stored_key_not_reusable`). So the key field reads
 * as empty once the target moves, and says why at once rather than on save:
 * the Save button waits for a key, and a disabled button that does not say
 * why is a dead end. The rule itself is `utils/aiProviderKeyReuse.ts`.
 *
 * A sibling of `useAiProviderForm`, which is at the file-size cap.
 */
import { computed, ref, type Ref } from 'vue';
import type { EmbeddingProviderKind, LanguageProviderKind } from '~/utils/aiProviders';
import type { OperationError } from '@owlat/shared/operationError';
import {
	STORED_KEY_NOT_REUSABLE_KEY,
	aiSaveRefusalOf,
	isStoredKeyStranded,
	storedKeyApplies,
	type StoredKeyFacts,
} from '~/utils/aiProviderKeyReuse';

/** The key fields of `aiProviderConfig.getConfig`, structurally. */
export interface StoredProviderKeys {
	languageProviderKind?: LanguageProviderKind;
	languageBaseUrl?: string;
	isLanguageKeySet: boolean;
	embeddingProviderKind?: EmbeddingProviderKind;
	isEmbeddingKeySet: boolean;
}

export function useAiProviderKeys(opts: {
	saved: () => StoredProviderKeys | null;
	form: {
		languageProviderKind: string;
		languageBaseUrl: string;
		apiKey: string;
		embeddingProviderKind: string;
		embeddingApiKey: string;
	};
	requiresKey: Readonly<Ref<boolean>>;
	embeddingRequiresKey: Readonly<Ref<boolean>>;
	/** The decision card owns its key note. */
	onDecisionKeyRefused: () => void;
}) {
	const { t } = useI18n();
	const { form } = opts;

	/** What the last save said, per field; cleared when its provider changes. */
	const languageSaveError = ref<string | null>(null);
	const embeddingSaveError = ref<string | null>(null);

	const languageFacts = computed<StoredKeyFacts | null>(() => {
		const row = opts.saved();
		return row
			? {
					isKeySet: row.isLanguageKeySet,
					kind: row.languageProviderKind,
					baseUrl: row.languageBaseUrl,
				}
			: null;
	});
	// A hosted embedder always uses its provider's endpoint: no base URL is stored.
	const embeddingFacts = computed<StoredKeyFacts | null>(() => {
		const row = opts.saved();
		return row
			? { isKeySet: row.isEmbeddingKeySet, kind: row.embeddingProviderKind, baseUrl: undefined }
			: null;
	});
	const languageTarget = () => ({
		kind: form.languageProviderKind,
		baseUrl: form.languageBaseUrl,
	});
	const embeddingTarget = () => ({ kind: form.embeddingProviderKind });

	const storedLanguageKeySet = computed(() =>
		storedKeyApplies(languageFacts.value, languageTarget())
	);
	const storedEmbeddingKeySet = computed(() =>
		storedKeyApplies(embeddingFacts.value, embeddingTarget())
	);
	const isLanguageKeyStranded = computed(() =>
		isStoredKeyStranded(languageFacts.value, languageTarget())
	);
	const isEmbeddingKeyStranded = computed(() =>
		isStoredKeyStranded(embeddingFacts.value, embeddingTarget())
	);

	const strandedNotice = (isStranded: boolean, typed: string, needsKey: boolean) =>
		isStranded && needsKey && !typed.trim() ? t(STORED_KEY_NOT_REUSABLE_KEY) : null;

	const languageError = computed(
		() =>
			languageSaveError.value ??
			strandedNotice(isLanguageKeyStranded.value, form.apiKey, opts.requiresKey.value)
	);
	const embeddingError = computed(
		() =>
			embeddingSaveError.value ??
			strandedNotice(
				isEmbeddingKeyStranded.value,
				form.embeddingApiKey,
				opts.embeddingRequiresKey.value
			)
	);

	/**
	 * `saveConfig`'s typed refusals, put on their field (`onError`: `true`
	 * claims the failure, so no toast repeats it). Anything else is left to the
	 * operation layer.
	 */
	function claimSaveRefusal(op: OperationError): boolean {
		const refusal = aiSaveRefusalOf(op);
		if (!refusal) return false;
		if (refusal.plane === 'language') {
			languageSaveError.value = t(STORED_KEY_NOT_REUSABLE_KEY);
		} else if (refusal.plane === 'embedding') {
			embeddingSaveError.value = t(STORED_KEY_NOT_REUSABLE_KEY);
		} else {
			opts.onDecisionKeyRefused();
		}
		return true;
	}

	return {
		claimSaveRefusal,
		languageSaveError,
		embeddingSaveError,
		storedLanguageKeySet,
		storedEmbeddingKeySet,
		isLanguageKeyStranded,
		isEmbeddingKeyStranded,
		languageError,
		embeddingError,
	};
}
