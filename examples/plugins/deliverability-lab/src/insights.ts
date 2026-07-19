/**
 * The prompt side of the plugin's budgeted LLM usage. Building the request is a
 * PURE function so it can be asserted directly; the actual generation goes
 * through the host's attributed, daily-budgeted dispatch (`ctx.llm` / cron
 * `services.llm`), never a raw model client. Keeping the prompt here also keeps
 * the untrusted-output boundary honest: the caller treats whatever the model
 * returns as text to clamp and log, never as an instruction.
 */

import type { PluginLlmGenerateRequest } from '@owlat/plugin-kit';

/** The deterministic set of deliverability topics the tip cron rotates through. */
export const DELIVERABILITY_TIP_TOPICS: readonly string[] = Object.freeze([
	'authentication (SPF, DKIM, DMARC alignment)',
	'list hygiene and sunset policies for unengaged recipients',
	'plain-text alternatives and image-to-text balance',
	'subject-line phrasing that avoids spam-trigger language',
	'link hygiene: HTTPS, consistent domains, and UTM tagging',
]);

/**
 * Pick a topic deterministically from a rotation index. Taking the index from
 * the caller (rather than a clock or RNG) keeps the whole cron reproducible in
 * tests: the same index always asks about the same topic.
 */
export function deliverabilityTipTopic(rotation: number): string {
	const count = DELIVERABILITY_TIP_TOPICS.length;
	const index = ((Math.trunc(rotation) % count) + count) % count;
	// Guarded by the modulo above; the fallback keeps the return type non-optional.
	return DELIVERABILITY_TIP_TOPICS[index] ?? DELIVERABILITY_TIP_TOPICS[0] ?? '';
}

/** Build the budgeted LLM request for a one-paragraph deliverability tip. */
export function buildDeliverabilityTipRequest(rotation: number): PluginLlmGenerateRequest {
	const topic = deliverabilityTipTopic(rotation);
	return {
		tier: 'fast',
		system:
			'You are a concise email-deliverability coach. Answer in one short paragraph, ' +
			'no preamble, no lists.',
		prompt: `Give one practical tip about ${topic} for a team sending marketing email.`,
	};
}
