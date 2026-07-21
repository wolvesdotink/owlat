/**
 * Connected-app capability presentation helpers.
 *
 * A plugin capability is a freeform `scope:verb` string (see
 * `@owlat/plugin-kit`'s `PluginCapability`). The connected-app registration UX
 * shows the operator exactly which of a plugin's declared capabilities an
 * external app will be granted. The raw key is always the authoritative contract
 * and is shown verbatim; these helpers only derive a friendlier label so the
 * grant list reads clearly. They invent NO capability semantics — the fixed
 * Tier-2 risk disclosure (an external app holds a secret and can only ever add
 * work or caution, never approve/unblock/send) is what actually communicates
 * risk, and that is true regardless of the specific capabilities.
 */

/** Title-case a single `scope`/`verb` segment: `plugin-storage` → `Plugin storage`. */
function humanizeSegment(segment: string): string {
	const words = segment.replace(/[-_]+/g, ' ').trim();
	if (!words) return '';
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A readable label for a capability key. A well-formed `scope:verb` renders as
 * `Scope · verb` (e.g. `mail:read` → `Mail · read`); a key without a colon is
 * humanized whole; an empty/whitespace key falls back to the raw string so the
 * UI never renders a blank row.
 */
export function connectedAppCapabilityLabel(capability: string): string {
	const trimmed = capability.trim();
	if (!trimmed) return capability;
	const colon = trimmed.indexOf(':');
	if (colon === -1) return humanizeSegment(trimmed);
	const scope = humanizeSegment(trimmed.slice(0, colon));
	const verb = trimmed
		.slice(colon + 1)
		.replace(/[-_]+/g, ' ')
		.trim();
	if (!scope) return trimmed;
	if (!verb) return scope;
	return `${scope} · ${verb}`;
}
