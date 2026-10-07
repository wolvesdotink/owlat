/**
 * Bounding the model's derived strings (INTERPRET_TEXT_LIMITS), applied after
 * parsing so a long string never fails the whole parse. Quotes stay verbatim:
 * grounding needs them. Pure.
 */

import {
	INTERPRET_TEXT_LIMITS,
	type InterpretFactProposal,
	type InterpretItemProposal,
	type InterpretOutput,
	type InterpretParticipantProposal,
} from './schema';

/** Strip control characters, collapse whitespace, cut at a word. */
export function clampText(value: string, max: number): string {
	const flat = value
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max - 1);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
}

const L = INTERPRET_TEXT_LIMITS;

function clampDisplay(display: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(display).map(([k, val]) => [k, clampText(val, L.display)])
	);
}

function clampParticipant(p: InterpretParticipantProposal): InterpretParticipantProposal {
	return {
		ref: p.ref,
		name: p.name === null ? null : clampText(p.name, L.participantName),
		email: p.email === null ? null : p.email.trim().slice(0, 254),
	};
}

/** Bound every derived string of the model output. Quotes stay verbatim (grounding needs them). */
export function clampOutput<O extends InterpretOutput>(output: O): O {
	const items = output.items.map((item) => ({
		...item,
		assertion: clampText(item.assertion, L.assertion),
		display: clampDisplay(item.display) as InterpretItemProposal['display'],
		requester: clampParticipant(item.requester),
		responsible: clampParticipant(item.responsible),
		beneficiary: item.beneficiary ? clampParticipant(item.beneficiary) : null,
		due: item.due
			? {
					...item.due,
					phrase: clampText(item.due.phrase, L.duePhrase),
					condition: item.due.condition ? clampText(item.due.condition, L.duePhrase) : null,
				}
			: null,
		options: item.options ? item.options.map((o) => clampText(o, L.option)) : null,
	}));
	if (output.mode === 'actions') return { ...output, items };
	return {
		...output,
		items,
		latest: Object.fromEntries(
			Object.entries(output.latest).map(([locale, lines]) => [
				locale,
				lines.map((line) => ({ ...line, text: clampText(line.text, L.latestLine) })),
			])
		) as typeof output.latest,
		facts: output.facts.map((fact) => ({
			...fact,
			key: {
				entity: clampText(fact.key.entity, L.factKeyPart),
				attribute: clampText(fact.key.attribute, L.factKeyPart),
				context: fact.key.context ? clampText(fact.key.context, L.factKeyPart) : null,
			},
			assertion: clampText(fact.assertion, L.assertion),
			display: clampDisplay(fact.display) as InterpretFactProposal['display'],
			value:
				fact.value && 'text' in fact.value
					? { ...fact.value, text: clampText(fact.value.text, L.factValueText) }
					: fact.value,
			reportedBy: clampParticipant(fact.reportedBy),
		})),
	} as O;
}
