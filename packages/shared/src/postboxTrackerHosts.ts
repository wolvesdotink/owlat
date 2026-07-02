/**
 * Well-known open-tracker host patterns for Postbox tracking-pixel detection.
 *
 * Pure DATA file — the matching logic lives in `postboxTrackers.ts`. Each
 * entry is a bare host suffix: an image src whose host equals the pattern or
 * ends with `.<pattern>` is treated as a known email open tracker.
 *
 * This list is intentionally small and conservative (marquee ESP/sales-tool
 * tracking domains only). It powers a client-side privacy BADGE — a miss is
 * harmless (remote images are blocked by default anyway) and a false positive
 * would mislabel legitimate mail, so favor precision over recall.
 */
export const TRACKER_HOST_PATTERNS: readonly string[] = [
	// Mailchimp / Mandrill
	'list-manage.com',
	'mandrillapp.com',
	// SendGrid
	'sendgrid.net',
	'ct.sendgrid.net',
	// HubSpot
	'hubspotlinks.com',
	'hs-analytics.net',
	't.hubspotemail.net',
	't.hubspotfree.net',
	// Mailgun
	'mailgun.org',
	'email.mailgun.net',
	// Campaign Monitor / Constant Contact
	'cmail19.com',
	'cmail20.com',
	'createsend1.com',
	'rs6.net',
	// Klaviyo / Braze / Iterable / Customer.io
	'klaviyomail.com',
	'braze.com',
	'iterable.com',
	'customeriomail.com',
	// Marketo / Pardot / Salesforce / ExactTarget
	'mktoresp.com',
	'pardot.com',
	'exacttarget.com',
	// Sailthru / SparkPost / Postmark
	'sailthru.com',
	'sparkpostmail.com',
	'pstmrk.it',
	// Sales email trackers
	'mailtrack.io',
	'mixmax.com',
	'yesware.com',
	'bananatag.com',
	'streak.com',
	'getnotify.com',
] as const;
