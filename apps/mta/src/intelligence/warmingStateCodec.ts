import { isValidNonGraduatedWarmingCap } from '@owlat/shared/warming';

const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

/**
 * Encoded shape version for the per-(IP x mailbox provider) warming state hash.
 *
 * The per-IP state shape is UNCHANGED by the provider dimension — legacy per-IP
 * rows are read and written exactly as before and carry no version — so only
 * the new provider hash is stamped. Bump this when the provider hash's encoded
 * fields change; readers treat an absent or older version as "defaults apply".
 */
export const WARMING_PROVIDER_STATE_CODEC_VERSION = 1;

export function decodeCanonicalPositiveSafeInteger(rawValue: unknown, fieldName: string): number {
	const persistedValue = String(rawValue);
	const decodedValue = Number(persistedValue);
	if (
		!CANONICAL_POSITIVE_INTEGER_PATTERN.test(persistedValue) ||
		!Number.isSafeInteger(decodedValue) ||
		decodedValue < 1
	) {
		throw new Error(`Redis returned a non-canonical ${fieldName}: ${persistedValue}`);
	}
	return decodedValue;
}

export function decodeNormalizedDailyCap(rawValue: unknown): number {
	if (rawValue === 'Infinity') return Infinity;
	const dailyCap = decodeCanonicalPositiveSafeInteger(rawValue, 'warming dailyCap');
	if (!isValidNonGraduatedWarmingCap(dailyCap)) {
		throw new Error(`Redis returned an out-of-range warming dailyCap: ${dailyCap}`);
	}
	return dailyCap;
}
