import type {
	DeliverabilityChecklistDefinition,
	DeliverabilityChecklistStatus,
	DeliverabilityScope,
	DeliverabilityValidatorEvidence,
} from './deliverabilityChecklist';

export const DELIVERABILITY_DIAGNOSTIC_LENGTH = 2_048;
export const DELIVERABILITY_OBSERVED_VALUE_LIMIT = 16;
export const DELIVERABILITY_OBSERVED_VALUE_LENGTH = 512;
export const DELIVERABILITY_OBSERVATION_SCHEMA_VERSION = 1;

type MutableStringSlot = {
	value: string;
	replace: (value: string) => void;
};

function observationStringSlots(value: unknown): MutableStringSlot[] {
	const slots: MutableStringSlot[] = [];
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const child = value[index];
			if (typeof child === 'string') {
				slots.push({
					value: child,
					replace: (replacement) => {
						value[index] = replacement;
					},
				});
			} else {
				slots.push(...observationStringSlots(child));
			}
		}
	} else if (value !== null && typeof value === 'object') {
		for (const [key, child] of Object.entries(value)) {
			if (typeof child === 'string') {
				if (key === 'kind') continue;
				slots.push({
					value: child,
					replace: (replacement) => {
						(value as Record<string, unknown>)[key] = replacement;
					},
				});
			} else {
				slots.push(...observationStringSlots(child));
			}
		}
	}
	return slots;
}

function encodedStringLength(value: string): number {
	return JSON.stringify(value).length - 2;
}

function prefixWithinEncodedLength(value: string, maxEncodedLength: number): string {
	const characters = [...value];
	let lower = 0;
	let upper = characters.length;
	while (lower < upper) {
		const midpoint = Math.ceil((lower + upper) / 2);
		if (encodedStringLength(characters.slice(0, midpoint).join('')) <= maxEncodedLength) {
			lower = midpoint;
		} else {
			upper = midpoint - 1;
		}
	}
	return characters.slice(0, lower).join('');
}

export function serializeDeliverabilityObservation(value: Record<string, unknown>): string {
	if (typeof value['kind'] !== 'string' || value['kind'].length === 0) {
		throw new Error('Deliverability observation kind is required');
	}
	const mutableValue = JSON.parse(
		JSON.stringify({
			...value,
			schemaVersion: DELIVERABILITY_OBSERVATION_SCHEMA_VERSION,
		})
	) as Record<string, unknown>;
	let serialized = JSON.stringify(mutableValue);
	while (serialized.length > DELIVERABILITY_OBSERVED_VALUE_LENGTH) {
		const slot = observationStringSlots(mutableValue).sort(
			(left, right) => encodedStringLength(right.value) - encodedStringLength(left.value)
		)[0];
		if (!slot || slot.value.length === 0) {
			throw new Error('Deliverability observation structure exceeds its bounded limit');
		}
		const excessLength = serialized.length - DELIVERABILITY_OBSERVED_VALUE_LENGTH;
		const targetLength = Math.max(0, encodedStringLength(slot.value) - excessLength);
		const replacement = prefixWithinEncodedLength(slot.value, targetLength);
		slot.replace(replacement === slot.value ? '' : replacement);
		serialized = JSON.stringify(mutableValue);
	}
	return serialized;
}

export function sanitizeDeliverabilityText(value: string): string {
	return [...value]
		.filter((character) => {
			const codePoint = character.codePointAt(0)!;
			const isPermittedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
			const isC0OrDel = codePoint < 32 || codePoint === 127;
			const isC1Control = codePoint >= 128 && codePoint <= 159;
			const isBidiControl =
				codePoint === 0x061c ||
				codePoint === 0x200e ||
				codePoint === 0x200f ||
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069);
			const isUnicodeLineSeparator = codePoint === 0x2028 || codePoint === 0x2029;
			return (
				isPermittedWhitespace ||
				(!isC0OrDel && !isC1Control && !isBidiControl && !isUnicodeLineSeparator)
			);
		})
		.join('');
}

const DIAGNOSTIC_REPORT_LENGTH = 12_000;

function checklistScopeLabel(scope: DeliverabilityScope): string {
	return scope.kind === 'deployment' ? 'deployment' : `domain ${scope.domain} (${scope.domainId})`;
}

function diagnosticReportLine(value: string, maxLength: number): string {
	return [...sanitizeDeliverabilityText(value)]
		.map((character) =>
			character === '\n' || character === '\r' || character === '\t' ? ' ' : character
		)
		.join('')
		.slice(0, maxLength);
}

export function deliverabilityDiagnosticReport(
	definition: DeliverabilityChecklistDefinition,
	scope: DeliverabilityScope,
	status: DeliverabilityChecklistStatus,
	evidence: DeliverabilityValidatorEvidence | null,
	diagnostic: string
): string {
	const observations = (evidence?.observedValues ?? [])
		.slice(0, DELIVERABILITY_OBSERVED_VALUE_LIMIT)
		.map((value) => `- ${diagnosticReportLine(value, DELIVERABILITY_OBSERVED_VALUE_LENGTH)}`);
	return [
		`Check: ${definition.title} (${definition.id})`,
		`Scope: ${diagnosticReportLine(checklistScopeLabel(scope), 512)}`,
		`Status: ${status}`,
		`Checked at: ${evidence ? new Date(evidence.observedAt).toISOString() : 'not checked'}`,
		`Validator: ${diagnosticReportLine(evidence?.validator ?? 'none', 128)}`,
		`Diagnostic: ${diagnosticReportLine(diagnostic, DELIVERABILITY_DIAGNOSTIC_LENGTH)}`,
		'Raw observations:',
		...(observations.length > 0 ? observations : ['- none']),
	]
		.join('\n')
		.slice(0, DIAGNOSTIC_REPORT_LENGTH);
}
