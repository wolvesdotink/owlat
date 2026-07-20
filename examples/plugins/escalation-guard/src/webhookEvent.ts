/**
 * Tier-1 webhook-event contribution (`webhookEvents`).
 *
 * A plugin webhook event ships NO executable code: the manifest declares the
 * namespaced event type and whether customer endpoints may subscribe to it, and
 * at emit time the plugin hands the host an already-built payload. That payload
 * is untrusted from the host's point of view, so this module builds it from
 * bounded primitives only — never raw mail content — and the host clamps and
 * scrubs it again before any delivery attempt.
 */

import { pluginWebhookEventKind, type PluginWebhookEventKind } from '@owlat/plugin-kit';
import { ESCALATION_GUARD_PLUGIN_ID } from './constants';
import type { EscalationVerdict } from './detector';

export const ESCALATION_EVENT_LOCAL_ID = 'escalation-raised';

/** `plugin.escalation-guard.escalation-raised` — collision-free by construction. */
export const ESCALATION_EVENT_KIND: PluginWebhookEventKind = pluginWebhookEventKind(
	ESCALATION_GUARD_PLUGIN_ID,
	ESCALATION_EVENT_LOCAL_ID
);

/** Maximum signal ids reported on the wire. */
export const MAX_EVENT_SIGNALS = 8;

/** Content-free event payload: a severity, the matched signal ids, and a count. */
export interface EscalationEventPayload {
	readonly level: EscalationVerdict['level'];
	readonly signals: readonly string[];
	readonly signalCount: number;
}

/**
 * Build the payload for one escalation event. Deliberately carries no subject,
 * body, address, or id: a subscriber learns that an escalation was detected and
 * why, and must call the API (with its own scoped key) for anything more.
 */
export function buildEscalationEventPayload(verdict: EscalationVerdict): EscalationEventPayload {
	const signals = verdict.signals.slice(0, MAX_EVENT_SIGNALS).map((signal) => signal.id);
	return { level: verdict.level, signals, signalCount: verdict.signals.length };
}
