/**
 * Whether bounce and complaint reports can reach this deployment for the
 * transports a message type uses.
 *
 * Every transport with a feedback channel signs its webhooks, and the
 * verifier rejects every report when its key is not set. A deployment in that
 * state still sends, but nothing it sends can ever be suppressed after a hard
 * bounce or a complaint, and built-in MTA sends never leave `queued` because
 * their delivery report never lands. Those keys are optional to CONNECT a
 * transport (the catalog keeps them out of `requiredEnvVars`, because a
 * provider issues its webhook secret after the transport is connected), so
 * "configured" says nothing about them; this module is the readiness half.
 *
 * Variable NAMES only, never values. A transport with no feedback channel at
 * all (a plain SMTP relay) reports nothing: there is no key that would help.
 */

import { isEnvPresent } from '../env';
import { providerFeedbackFor } from '../../providers/feedback';
import { feedbackVerifierEnvVars } from '../../providers/feedbackStatus';
import type { SendProviderKind } from './types';

/** The unset variables that keep one transport's feedback reports out. */
export function missingFeedbackVariables(kind: SendProviderKind): string[] {
	const feedback = providerFeedbackFor(kind);
	if (!feedback) return [];
	return feedbackVerifierEnvVars(feedback.verifier).filter((name) => !isEnvPresent(name));
}

/** {@link missingFeedbackVariables} over several transports, each name once. */
export function missingFeedbackVariablesFor(kinds: readonly SendProviderKind[]): string[] {
	return [...new Set(kinds.flatMap(missingFeedbackVariables))];
}
