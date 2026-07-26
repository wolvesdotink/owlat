import type {
	DeliverabilityChecklistDefinition,
	DeliverabilityChecklistStatus,
	DeliverabilityScope,
	DeliverabilityValidatorEvidence,
} from './deliverabilityChecklist';

export const DELIVERABILITY_DIAGNOSTIC_LENGTH = 2_048;
export const DELIVERABILITY_OBSERVED_VALUE_LIMIT = 16;
export const DELIVERABILITY_OBSERVED_VALUE_LENGTH = 512;

export function sanitizeDeliverabilityText(value: string): string {
	return [...value]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
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
		`Scope: ${checklistScopeLabel(scope)}`,
		`Status: ${status}`,
		`Checked at: ${evidence ? new Date(evidence.observedAt).toISOString() : 'not checked'}`,
		`Validator: ${evidence?.validator ?? 'none'}`,
		`Diagnostic: ${diagnosticReportLine(diagnostic, DELIVERABILITY_DIAGNOSTIC_LENGTH)}`,
		'Raw observations:',
		...(observations.length > 0 ? observations : ['- none']),
	]
		.join('\n')
		.slice(0, DIAGNOSTIC_REPORT_LENGTH);
}
