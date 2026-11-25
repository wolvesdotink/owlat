/**
 * Which destination URLs a webhook may have. Create and update validate
 * through `assertValidWebhookUrl`, and the delivery side asks
 * `isEventAllowedOverUrl` before it writes or sends a delivery, so a URL stored
 * before a rule tightened cannot keep receiving what the rule now forbids.
 *
 * The host rules are the front door only: the v8 runtime cannot resolve DNS,
 * so the delivery action re-validates the resolved address and sends with
 * redirects off (`webhooks/delivery.ts`).
 */

import { throwInvalidInput } from '../_utils/errors';
import { isDisallowedIpAddress } from '../lib/ipBlocklist';

/**
 * Events that describe the instance's own sending problems. Sent in cleartext
 * they tell anyone on the path which checks fail and what to fix, so a webhook
 * subscribed to one needs an `https` URL. There is no local exception: a
 * webhook URL cannot point at localhost anyway.
 */
export const HTTPS_ONLY_WEBHOOK_EVENTS: readonly string[] = [
	'deliverability.alert_raised',
	'deliverability.alert_resolved',
];

function isDisallowedWebhookHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	// Hostname-only rules first, then the shared literal-IP blocklist so this
	// can't diverge from lib/ssrfGuard.
	if (host === 'localhost' || host.endsWith('.local')) {
		return true;
	}
	return isDisallowedIpAddress(host);
}

function isHttps(url: string): boolean {
	try {
		return new URL(url).protocol === 'https:';
	} catch {
		return false;
	}
}

/** A stored webhook may receive `event` at `url`. */
export function isEventAllowedOverUrl(event: string, url: string): boolean {
	return !HTTPS_ONLY_WEBHOOK_EVENTS.includes(event) || isHttps(url);
}

/**
 * Validate a webhook destination for the events it subscribes to: a
 * well-formed http(s) URL whose host is not localhost, a *.local name or a
 * disallowed literal IP, and `https` when an event needs it. Throws an
 * invalid-input error on any failure. The caller passes the trimmed string.
 */
export function assertValidWebhookUrl(url: string, events: readonly string[]): void {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throwInvalidInput('Invalid webhook URL format');
	}
	if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
		throwInvalidInput('Webhook URL must use HTTP or HTTPS protocol');
	}
	if (isDisallowedWebhookHost(parsedUrl.hostname)) {
		throwInvalidInput('Webhook URL host is not allowed');
	}
	if (events.some((event) => !isEventAllowedOverUrl(event, url))) {
		throwInvalidInput('Deliverability alert webhooks need an HTTPS URL');
	}
}
