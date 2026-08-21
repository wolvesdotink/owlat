/**
 * The single-reference-relay rule (plan D8), turned into something a screen can
 * say.
 *
 * The measurement plane compares TWO arms: our own MTA and one reference relay.
 * With two relays enabled there is no single second arm, the alignment verdict
 * degrades to `unknown`, and every cell holds at its current share — quietly,
 * because "unknown" is also what a DNS timeout looks like. A team migrating from
 * Mandrill hits this the moment they leave an old SES or Resend key configured
 * beside it, and nothing on screen tells them why the ramp never moves.
 *
 * The backend already writes the finding: `getAlignmentArms` answers
 * `reference: { kind: 'unknown', detail }`, and the detail sentence names the
 * relays. This module does not restate it — it CLASSIFIES it, because the two
 * `unknown` branches want opposite remedies, and hands the caller the backend's
 * own sentence to render verbatim.
 */

import { isMultiRelayDetail } from '@owlat/shared/deliverabilityAlignment';
import type { ReferenceArmInput } from '@owlat/shared/deliverabilityAlignment';

/**
 * The shape a screen renders: a title, the backend's sentence, one remedy.
 *
 * `title` and `remedy` are i18n KEYS — this module is pure, so the component
 * showing the notice runs them through `t()`. `detail` is not: it is the
 * backend's own sentence, rendered as it arrived.
 */
export interface ReferenceRelayNotice {
	/** `multi_relay` is D8's rule; `undescribed` is one relay we cannot see. */
	readonly kind: 'multi_relay' | 'undescribed';
	readonly title: string;
	/** The backend's own sentence, unedited — it names the relays involved. */
	readonly detail: string;
	readonly remedy: string;
}

/**
 * What (if anything) to warn about, given the live arms read.
 *
 * `undefined` in, `null` out: a read still in flight is not a finding, and
 * neither is `none` (the supported standalone deployment) or a describable arm.
 */
export function referenceRelayNotice(
	arms: { reference: ReferenceArmInput } | null | undefined
): ReferenceRelayNotice | null {
	const reference = arms?.reference;
	if (reference === undefined || reference.kind !== 'unknown') return null;
	if (isMultiRelayDetail(reference.detail)) {
		return {
			kind: 'multi_relay',
			title: 'shared.referenceRelay.multiRelay.title',
			detail: reference.detail,
			remedy: 'shared.referenceRelay.multiRelay.remedy',
		};
	}
	return {
		kind: 'undescribed',
		title: 'shared.referenceRelay.undescribed.title',
		detail: reference.detail,
		remedy: 'shared.referenceRelay.undescribed.remedy',
	};
}
