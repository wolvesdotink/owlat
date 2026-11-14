/**
 * Who a Mandrill bounce is about. Mandrill documents two typed signals for it:
 * the event name, where `hard_bounce` is a permanent failure such as an invalid
 * mailbox, which Mandrill then denylists ("Bounces" in
 * https://mailchimp.com/developer/transactional/docs/reputation-rejections/),
 * and `diag`, "the SMTP response from the recipient's server"
 * (https://mailchimp.com/developer/transactional/api/messages/info/), whose
 * enhanced status code is read and never its prose. `bounce_description` has
 * no published vocabulary, so it is not read.
 *
 * A hard bounce is the recipient's unless the code names our identity; a soft
 * bounce counts against the recipient only when its code says so.
 */

import { relayBounceCause, smtpReplyEnhancedCode } from '@owlat/shared/bounceCause';
import type { BounceCause } from '@owlat/shared/smtpBlockCategories';

export function mandrillBounceCause(
	event: 'hard_bounce' | 'soft_bounce',
	diag: string | undefined
): BounceCause {
	return relayBounceCause(
		event === 'hard_bounce' ? 'address-failed' : 'unattributed',
		smtpReplyEnhancedCode(diag)
	);
}
