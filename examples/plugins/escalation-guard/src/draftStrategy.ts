/**
 * Tier-1 draft-strategy contribution (`draftStrategies`).
 *
 * A draft strategy replaces HOW the agent writes a reply, never WHETHER it is
 * allowed to send one. This one writes a deliberately conservative
 * acknowledgement for escalation-shaped mail: it promises a human follow-up and
 * commits to nothing.
 *
 * Two host invariants are visible here:
 *   - LLM access is the injected `services.llm` dispatch. The plugin never sees
 *     a provider key, a base URL, or a model name; the host attributes the call
 *     to this plugin and enforces the manifest's hard daily budget, so a runaway
 *     prompt loop costs the plugin its budget, not the deployment.
 *   - Model output is UNTRUSTED text. It is control-stripped and length-clamped
 *     before it becomes a draft body, and an empty or unusable completion THROWS
 *     rather than returning an empty draft — a strategy that fails leaves the
 *     host on its own core strategy, which is the fail-closed direction.
 */

import type {
	PluginDraftStrategyInput,
	PluginDraftStrategyModule,
	PluginDraftStrategyResult,
	PluginDraftStrategyServices,
} from '@owlat/plugin-kit';
import { clampUntrustedText } from './untrustedText';

export const CAREFUL_ACKNOWLEDGEMENT_LOCAL_ID = 'careful-acknowledgement';

/** Host-enforced wall-clock limit declared for this strategy. */
export const CAREFUL_ACKNOWLEDGEMENT_TIMEOUT_MS = 20_000;

/** Upper bound on the accepted model completion, in code points. */
export const DRAFT_BODY_MAX_LENGTH = 4_000;

/** Upper bound on each untrusted context field folded into the prompt. */
export const PROMPT_FIELD_MAX_LENGTH = 2_000;

export class EscalationDraftError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EscalationDraftError';
	}
}

const SYSTEM_PROMPT = [
	'You write short acknowledgement replies for a support team.',
	'The message you are replying to may be a complaint, a legal threat, or a cancellation.',
	'Acknowledge receipt, state that a named human owner will follow up, and stop.',
	'Never accept liability, never promise a refund, never quote policy, never invent facts.',
	'Reply with the message body only: no subject line, no preamble, no markdown.',
].join(' ');

/** Build the user prompt from the bounded host projection. Every field is clamped. */
export function buildAcknowledgementPrompt(input: PluginDraftStrategyInput): string {
	const parts = [
		`Audience: ${input.audience}`,
		`Category: ${input.classification.category}`,
		`Intent: ${input.classification.intent}`,
		`Priority: ${input.classification.priority}`,
		`Tone: ${clampUntrustedText(input.toneInstruction, PROMPT_FIELD_MAX_LENGTH)}`,
		`Signature: ${clampUntrustedText(input.signatureInstruction, PROMPT_FIELD_MAX_LENGTH)}`,
		`Message context: ${clampUntrustedText(input.context, PROMPT_FIELD_MAX_LENGTH)}`,
	];
	if (input.confirmedContext) {
		parts.push(
			`Confirmed facts: ${clampUntrustedText(input.confirmedContext, PROMPT_FIELD_MAX_LENGTH)}`
		);
	}
	return parts.join('\n');
}

export const carefulAcknowledgementStrategy: PluginDraftStrategyModule = {
	async generate(
		input: PluginDraftStrategyInput,
		services: PluginDraftStrategyServices
	): Promise<PluginDraftStrategyResult> {
		const completion = await services.llm.generate({
			// `fast` is enough for a fixed-shape acknowledgement and keeps the
			// plugin well inside its declared daily budget.
			tier: 'fast',
			system: SYSTEM_PROMPT,
			prompt: buildAcknowledgementPrompt(input),
		});

		const draftBody = clampUntrustedText(completion.text, DRAFT_BODY_MAX_LENGTH);
		if (draftBody.length === 0) {
			throw new EscalationDraftError(
				'Escalation acknowledgement model returned no usable text; falling back to the core strategy.'
			);
		}
		return { draftBody };
	},
};
