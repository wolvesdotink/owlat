/**
 * Decision plane — the question-set catalog.
 *
 * Every question set the product asks is DECLARED here and nowhere else. The
 * reason is the promise the plane is built on: any adapter answers any question
 * set, and reverting the plane is a dropdown rather than a revert. That only
 * holds if there is one enumerable list of what gets asked, because the
 * conformance suite beside this file runs the whole list through BOTH adapters
 * and asserts they answer with the same keys, the same value domains and the
 * same probability key spaces. A set built inline at a call site is a set no
 * suite ever ran through the language-backed path, and the day the vendor is
 * unreachable is the day it is discovered.
 *
 * Registration is therefore how a set comes into existence: {@link register}
 * returns the set it recorded, so the export and the registry entry are one
 * statement and cannot drift.
 *
 * Pure and isolate-safe, like `./questions.ts` — the DSL builders validate each
 * question at construction, so a malformed set fails at import rather than on
 * the inbound path.
 */

import type { QuestionSet } from './questions';
import { noul } from './questions';

/** One catalog entry: the set, its id, and what asks it. */
export interface RegisteredQuestionSet {
	/** Stable id, also the accounting `feature` prefix a caller should use. */
	readonly id: string;
	/** Who asks it and what it decides — read by a human, not by code. */
	readonly purpose: string;
	readonly questions: QuestionSet;
}

const REGISTRY = new Map<string, RegisteredQuestionSet>();
const REGISTERED = new WeakSet<object>();

/**
 * Record a question set. Duplicate ids are refused: two sets under one name
 * would make the conformance report and the ledger's `feature` tag disagree
 * about which one was measured.
 *
 * Called on the line after the set it registers, rather than wrapping it, so the
 * export stays a plain value — `scripts/check-entry-wiring.ts` reads exports
 * wrapped in an unknown call as a possible Convex door and refuses them.
 */
function register(id: string, purpose: string, questions: QuestionSet): void {
	if (REGISTRY.has(id)) {
		throw new Error(`Decision question set '${id}' is already registered.`);
	}
	REGISTRY.set(id, { id, purpose, questions });
	REGISTERED.add(questions);
}

/** Every registered set, in registration order. The conformance suite's input. */
export function registeredQuestionSets(): RegisteredQuestionSet[] {
	return [...REGISTRY.values()];
}

/** Whether this exact set came from the catalog. Identity, not shape: two sets
 * that look alike are still two sets, and only one of them was measured. */
export function isRegisteredQuestionSet(questions: QuestionSet): boolean {
	return REGISTERED.has(questions);
}

/**
 * The settings page's connection probe — the smallest honest question set there
 * is, and the only one P1 ships.
 *
 * It exists because "Test connection" has to make a real round trip to mean
 * anything: a key that is well-formed and revoked passes every local check and
 * fails every decision afterwards, on the inbound path, where nobody is
 * watching a button. One Noul over a nine-word state costs a handful of input
 * tokens, and output tokens are free on this plane.
 *
 * The state is deliberately dull. It is a sentence about the weather because a
 * probe is not the place to send a customer's mail, and because an answer either
 * way proves the same thing: the endpoint, the key and the codec all work.
 */
export const CONNECTION_PROBE_QUESTIONS = {
	reachable: noul('Does this sentence describe rain?', {
		true: 'The sentence says it is raining.',
		false: 'The sentence says anything else.',
	}),
};
register(
	'settings.connection_probe',
	'The AI-provider settings page, testing a stored decision key end to end.',
	CONNECTION_PROBE_QUESTIONS
);

/** The state {@link CONNECTION_PROBE_QUESTIONS} is asked about. */
export const CONNECTION_PROBE_STATE = 'It is raining in Hamburg this afternoon.';

/** Accounting tag for the probe, so a test button's spend is legible in the ledger. */
export const CONNECTION_PROBE_FEATURE = 'settings.decision_connection_test';
