/**
 * When a stored API key still applies, and the settings-save refusal the
 * AI-provider form shows on a field instead of as a toast. Pure: message keys
 * only, the composables translate.
 *
 * The server keeps a plane's stored key only while the plane targets the same
 * provider kind and the same normalized base URL (`lib/aiProviderSecrets.ts`,
 * `stored_key_not_reusable`). The form asks the same question through the
 * same shared rule, so the key field shows as empty and the save explains
 * itself before the round trip, instead of a refused save afterwards.
 */
import { isSameKeyTarget } from '@owlat/shared/aiModelCatalog';
import type { OperationError } from '@owlat/shared/operationError';

/** A plane's stored key, as `aiProviderConfig.getConfig` describes it. */
export interface StoredKeyFacts {
	isKeySet: boolean;
	kind: string | undefined;
	baseUrl: string | undefined;
}

/** Where the form now points the plane. */
export interface KeyTargetForm {
	kind: string;
	/** As typed; blank means the provider's own endpoint. */
	baseUrl?: string;
}

/** Whether the stored key will be kept by a save of the form as it stands. */
export function storedKeyApplies(stored: StoredKeyFacts | null, next: KeyTargetForm): boolean {
	if (!stored?.isKeySet) return false;
	return isSameKeyTarget(
		{ kind: stored.kind, baseUrl: stored.baseUrl },
		{ kind: next.kind, baseUrl: next.baseUrl?.trim() || undefined }
	);
}

/** A key is stored, but the form now targets another provider or address, so it is dropped. */
export function isStoredKeyStranded(stored: StoredKeyFacts | null, next: KeyTargetForm): boolean {
	return stored?.isKeySet === true && !storedKeyApplies(stored, next);
}

/** The inline sentence for a stranded key on the language and embedding planes. */
export const STORED_KEY_NOT_REUSABLE_KEY = 'shared.aiProviders.validation.storedKeyNotReusable';

export type AiPlane = 'language' | 'embedding' | 'decision';

/** A refused settings save the form puts on a field. */
export type AiSaveRefusal = { kind: 'storedKeyNotReusable'; plane: AiPlane };

const PLANES: ReadonlySet<string> = new Set(['language', 'embedding', 'decision']);

/** `saveConfig`'s stored-key refusal, read off `data.reason`; null for anything else. */
export function aiSaveRefusalOf(op: OperationError): AiSaveRefusal | null {
	const reason = op.data?.['reason'];
	if (reason === 'stored_key_not_reusable') {
		const plane = op.data?.['plane'];
		return typeof plane === 'string' && PLANES.has(plane)
			? { kind: 'storedKeyNotReusable', plane: plane as AiPlane }
			: null;
	}
	return null;
}
