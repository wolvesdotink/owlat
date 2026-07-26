import { isValidNonGraduatedWarmingCap } from '@owlat/shared/warming';

const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

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
