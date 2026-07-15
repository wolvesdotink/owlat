import { PluginHostError } from './errors';

export interface PluginUntrustedTextPolicy {
	readonly maximumCharacters: number;
	readonly scrubPromptInjection: (boundedText: string) => string;
}

/**
 * Bound and scrub plugin text before a consumer can put it in a prompt. There
 * is intentionally no permissive default: every host adapter must name the
 * policy appropriate for its runtime.
 */
export function applyPluginUntrustedTextPolicy(
	pluginId: string,
	text: string,
	policy: PluginUntrustedTextPolicy
): string {
	validateUntrustedTextPolicy(pluginId, policy);
	if (typeof text !== 'string') {
		throw new PluginHostError(
			'untrusted_output_rejected',
			`Plugin ${pluginId} returned a non-string value on an untrusted-text boundary`,
			{ pluginId }
		);
	}
	const boundedText = clampText(text, policy.maximumCharacters);

	let scrubbedText: unknown;
	try {
		scrubbedText = policy.scrubPromptInjection(boundedText);
	} catch (cause) {
		throw new PluginHostError(
			'untrusted_output_rejected',
			`Plugin ${pluginId} output could not be scrubbed`,
			{ pluginId, cause }
		);
	}

	if (typeof scrubbedText !== 'string') {
		throw new PluginHostError(
			'untrusted_output_rejected',
			`Plugin ${pluginId} output scrubber returned a non-string value`,
			{ pluginId }
		);
	}
	return clampText(scrubbedText, policy.maximumCharacters);
}

export function validateUntrustedTextPolicy(
	pluginId: string,
	policy: PluginUntrustedTextPolicy
): void {
	if (
		policy === null ||
		typeof policy !== 'object' ||
		!Number.isSafeInteger(policy.maximumCharacters) ||
		policy.maximumCharacters <= 0 ||
		typeof policy.scrubPromptInjection !== 'function'
	) {
		throw new PluginHostError(
			'invalid_untrusted_text_policy',
			`Plugin ${pluginId} requires an explicit, positive untrusted-text policy`,
			{ pluginId }
		);
	}
}

function clampText(text: string, maximumCharacters: number): string {
	if (text.length <= maximumCharacters) return text;
	if (maximumCharacters === 1) return '…';
	return `${text.slice(0, maximumCharacters - 1)}…`;
}
