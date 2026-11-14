/**
 * Who an Amazon SES bounce is about, from SES's documented bounce types and
 * subtypes ("Bounce types" in
 * https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html).
 * Resend delivers through SES and reports the same `type` / `subType` pair on
 * its `email.bounced` event, so its adapter reads this table too.
 *
 *  - `Permanent`: AWS says to remove the address. `General`, `NoEmail` (SES
 *    could not read the address out of the bounce) and any subtype SES adds
 *    later are `address-failed`, so an enhanced code naming our identity (a
 *    `5.7.1` block) still keeps the address. The suppression-list subtypes are
 *    SES refusing an address it already holds as bad: the recipient's.
 *  - `Transient`: SES says the same recipient may take mail later. A full
 *    mailbox is the recipient's; a rejected message, size or attachment is
 *    ours; `General` and anything else is unattributed and left to the code.
 *  - `Undetermined` (or a type we do not know): unattributed.
 *
 * `Temporary` is the name one Resend page gives the transient type.
 */

import {
	causeCodeOf,
	relayBounceCause,
	smtpReplyEnhancedCode,
	type RelayBounceVerdict,
} from '@owlat/shared/bounceCause';
import type { BounceCause } from '@owlat/shared/smtpBlockCategories';

const PERMANENT_RECIPIENT_SUBTYPES: ReadonlySet<string> = new Set([
	'Suppressed',
	'OnAccountSuppressionList',
	'OnTenantSuppressionList',
	'EmailValidationSuppressed',
	'UnsubscribedRecipient',
]);

const TRANSIENT_SENDER_SUBTYPES: ReadonlySet<string> = new Set([
	'MessageTooLarge',
	'ContentRejected',
	'AttachmentRejected',
]);

function sesBounceVerdict(
	bounceType: string | undefined,
	bounceSubType: string | undefined
): RelayBounceVerdict {
	if (bounceType === 'Permanent') {
		return bounceSubType !== undefined && PERMANENT_RECIPIENT_SUBTYPES.has(bounceSubType)
			? 'recipient'
			: 'address-failed';
	}
	if (bounceType === 'Transient' || bounceType === 'Temporary') {
		if (bounceSubType === 'MailboxFull') return 'recipient';
		if (bounceSubType !== undefined && TRANSIENT_SENDER_SUBTYPES.has(bounceSubType)) {
			return 'sender';
		}
	}
	return 'unattributed';
}

/**
 * The cause of one SES-vocabulary bounce. `status` is the DSN `Status` SES
 * copies onto the bounced recipient, `diagnostics` the remote server's replies
 * (`smtp; 550 5.7.1 ...`); either may be absent.
 */
export function sesBounceCause(bounce: {
	bounceType: string | undefined;
	bounceSubType: string | undefined;
	status?: string;
	diagnostics: readonly (string | undefined)[];
}): BounceCause {
	const reply = bounce.diagnostics.find((text) => smtpReplyEnhancedCode(text) !== undefined);
	return relayBounceCause(
		sesBounceVerdict(bounce.bounceType, bounce.bounceSubType),
		causeCodeOf(bounce.status, reply)
	);
}
