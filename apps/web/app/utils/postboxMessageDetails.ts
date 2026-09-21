/**
 * The "message details" rows behind the reader's sender badge (UX plan idea 52).
 *
 * The badge says "Verified sender" and, until now, nothing let a reader check
 * that. This turns the persisted header facts into the rows a disclosure panel
 * renders: the addresses the message carries, each authentication verdict WITH
 * the exact domain it authenticated, and the forwarder whose ARC seal was
 * honoured when a rescue applied.
 *
 * Two rules, both the honesty rule the badge lives by:
 *
 *   - A row exists only when the fact behind it exists. A verdict we never
 *     recorded is absent from the panel rather than shown as "none" — the reader
 *     is checking OUR claims, so an invented row would be worse than no panel.
 *   - The verdict rows never say more than the stored value. `pass` for a domain
 *     that is not the sender's still reads `pass`, and the domain beside it is
 *     what makes that legible; the interpretation is the badge's job and stays
 *     in one place.
 *
 * Module scope, so nothing here calls `useI18n`: labels are catalog KEYS and the
 * values beside them are data (addresses, domains, verdict words) rendered
 * verbatim. Pure, so it tests without mounting anything.
 */

/** The projection `mail.mailbox.messages.getMessageDetails` returns. */
export interface MessageDetailsSource {
	fromAddress: string;
	fromName?: string;
	replyToAddress?: string;
	rfc822MessageId?: string;
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
	envelopeFromDomain?: string;
	dkimSigningDomain?: string;
	dmarcOverride?: string;
	arcSealer?: string;
}

/** How a row's value should read: an authentication outcome, or plain data. */
export type MessageDetailTone = 'pass' | 'fail' | 'neutral' | 'warn';

export interface MessageDetailRow {
	/** Stable id for keys and tests. */
	id: string;
	/** Row label — a catalog key. */
	label: string;
	/**
	 * The verdict word exactly as the MTA recorded it (`pass`, `fail`, `softfail`
	 * …), rendered as a chip. Absent on the address rows.
	 */
	verdict?: string;
	tone: MessageDetailTone;
	/** The address / domain the row is about. Data, never translated. */
	value: string;
	/**
	 * A short note beside the value — a catalog key. Used where the value alone
	 * would be ambiguous (which domain a verdict authenticated, or that a
	 * Reply-To differs from the From address).
	 */
	note?: string;
}

const KEY = 'components.postbox.postboxMessageDetails';

function norm(value: string | undefined): string {
	return (value ?? '').trim().toLowerCase();
}

/** The domain half of an address, empty when there isn't one. */
export function domainOf(address: string | undefined): string {
	const angled = (address ?? '').match(/<([^>]+)>/)?.[1] ?? address ?? '';
	return angled.trim().toLowerCase().split('@')[1] ?? '';
}

/**
 * `pass` is the only outcome we colour as a pass. `fail` and the SPF variants
 * that mean "the domain says no" read as failures; everything else (`none`,
 * `neutral`, `temperror`, an unknown word from another MTA) is neutral, because
 * it is not a verdict either way and dressing it up as one would be the exact
 * overclaim this panel exists to prevent.
 */
function verdictTone(result: string): MessageDetailTone {
	if (result === 'pass') return 'pass';
	if (result === 'fail' || result === 'softfail' || result === 'permerror') return 'fail';
	return 'neutral';
}

/** What the sender's domain asked receivers to do with a failing message. */
const POLICY_NOTES: Record<string, string | undefined> = {
	none: `${KEY}.notes.policy.none`,
	quarantine: `${KEY}.notes.policy.quarantine`,
	reject: `${KEY}.notes.policy.reject`,
};

/**
 * Build the panel's rows, in the order the reader reads them: who the message
 * says it is from, where a reply is invited, then what each check actually
 * authenticated, then the forwarder that vouched for a rescued message.
 *
 * Returns [] only when there is genuinely nothing to show (no addresses and no
 * verdicts at all), which lets the caller render nothing rather than an empty
 * card.
 */
export function buildMessageDetailRows(source: MessageDetailsSource): MessageDetailRow[] {
	const rows: MessageDetailRow[] = [];
	const fromDomain = domainOf(source.fromAddress);

	const from = source.fromAddress.trim();
	if (from) {
		// Recomposed as the header reads it — display name AND address — because a
		// name that does not match the address it hides is exactly what the reader
		// opened this panel to see.
		const name = source.fromName?.trim();
		rows.push({
			id: 'from',
			label: `${KEY}.from`,
			tone: 'neutral',
			value: name ? `${name} <${from}>` : from,
		});
	}

	// Return-Path: we persist the envelope sender's DOMAIN (what SPF
	// authenticated), not the full address — the row says domain, and means it.
	const envelope = norm(source.envelopeFromDomain);
	if (envelope) {
		rows.push({
			id: 'returnPath',
			label: `${KEY}.returnPath`,
			tone: 'neutral',
			value: envelope,
			note: `${KEY}.notes.envelopeDomain`,
		});
	}

	// Reply-To, flagged when a reply is invited at a DIFFERENT domain than the
	// visible From — the shape the reply guard fires on, shown here as the fact
	// it rests on.
	const replyTo = source.replyToAddress?.trim();
	if (replyTo) {
		const replyDomain = domainOf(replyTo);
		const differs = replyDomain !== '' && fromDomain !== '' && replyDomain !== fromDomain;
		rows.push({
			id: 'replyTo',
			label: `${KEY}.replyTo`,
			tone: differs ? 'warn' : 'neutral',
			value: replyTo,
			...(differs ? { note: `${KEY}.notes.replyToDiffers` } : {}),
		});
	}

	const spf = norm(source.spfResult);
	if (spf) {
		rows.push({
			id: 'spf',
			label: `${KEY}.spf`,
			verdict: spf,
			tone: verdictTone(spf),
			value: envelope,
			...(envelope ? {} : { note: `${KEY}.notes.noDomainRecorded` }),
		});
	}

	const dkim = norm(source.dkimResult);
	if (dkim) {
		const signing = norm(source.dkimSigningDomain);
		rows.push({
			id: 'dkim',
			label: `${KEY}.dkim`,
			verdict: dkim,
			tone: verdictTone(dkim),
			value: signing,
			...(signing ? {} : { note: `${KEY}.notes.noDomainRecorded` }),
		});
	}

	const dmarc = norm(source.dmarcResult);
	if (dmarc) {
		// The published policy is an enum with three values; an unrecognised one
		// gets NO note rather than a key path built from the stored string.
		const policyNote = POLICY_NOTES[norm(source.dmarcPolicy)];
		rows.push({
			id: 'dmarc',
			label: `${KEY}.dmarc`,
			verdict: dmarc,
			tone: verdictTone(dmarc),
			// DMARC is the alignment check, so the domain it is about is the visible
			// From — the one the reader is being asked to trust.
			value: fromDomain,
			...(policyNote ? { note: policyNote } : {}),
		});
	}

	// Only when the backend actually applied the rescue: `dmarcOverride === 'arc'`
	// is the single thing that can put this row (and the badge's forwarder state)
	// on screen.
	if (norm(source.dmarcOverride) === 'arc') {
		const sealer = norm(source.arcSealer);
		rows.push({
			id: 'arc',
			label: `${KEY}.arc`,
			tone: 'pass',
			value: sealer,
			note: sealer ? `${KEY}.notes.arcRescue` : `${KEY}.notes.arcRescueUnnamed`,
		});
	}

	if (source.rfc822MessageId?.trim()) {
		rows.push({
			id: 'messageId',
			label: `${KEY}.messageId`,
			tone: 'neutral',
			value: source.rfc822MessageId.trim(),
		});
	}

	return rows;
}
