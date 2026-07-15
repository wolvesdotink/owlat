import type { PluginId } from '@owlat/plugin-kit';
import { PluginHostError } from './errors';

export interface PluginUntrustedTextPolicy {
	/** Maximum Unicode code points in accepted output, including a truncation ellipsis. */
	readonly maximumCodePoints: number;
	/** Inspect the complete, original plugin text before the host truncates it. */
	readonly scrubPromptInjection: (untrustedText: string) => string;
}

/**
 * Bound and scrub plugin text before a consumer can put it in a prompt. There
 * is intentionally no permissive default: every host adapter must name the
 * policy appropriate for its runtime.
 */
export function applyPluginUntrustedTextPolicy(
	pluginId: PluginId,
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
	let scrubbedText: unknown;
	try {
		scrubbedText = policy.scrubPromptInjection(text);
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
	return clampCodePoints(scrubbedText, policy.maximumCodePoints);
}

export function validateUntrustedTextPolicy(
	pluginId: PluginId,
	policy: PluginUntrustedTextPolicy
): void {
	if (
		policy === null ||
		typeof policy !== 'object' ||
		!Number.isSafeInteger(policy.maximumCodePoints) ||
		policy.maximumCodePoints <= 0 ||
		typeof policy.scrubPromptInjection !== 'function'
	) {
		throw new PluginHostError(
			'invalid_untrusted_text_policy',
			`Plugin ${pluginId} requires an explicit, positive untrusted-text policy`,
			{ pluginId }
		);
	}
}

function clampCodePoints(text: string, maximumCodePoints: number): string {
	const prefix: string[] = [];
	for (const codePoint of text) {
		if (prefix.length === maximumCodePoints) {
			return `${prefix.slice(0, -1).join('')}…`;
		}
		prefix.push(codePoint);
	}
	return text;
}
