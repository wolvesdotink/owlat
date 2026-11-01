/**
 * The Team Inbox classifier's intent domain: the exact enum its structured
 * output allows (`./index.ts` `classificationSchema`). Pure, so the complexity
 * router (`lib/llm/complexity.ts`) can type its intent sets against it.
 */

export const CLASSIFY_INTENTS = [
	'question',
	'complaint',
	'request',
	'information',
	'escalation',
	'acknowledgment',
] as const;

export type ClassifyIntent = (typeof CLASSIFY_INTENTS)[number];
