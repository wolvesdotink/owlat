/**
 * Automated-click classification.
 *
 * Mail security gateways (Mimecast, Proofpoint URL Defense, Barracuda,
 * Microsoft Safe Links) follow every link in a message to inspect the target.
 * Counting those requests as clicks inflates click rates and can hand an A/B
 * test on click rate to the wrong variant.
 *
 * It follows the same two steps as open classification (`automatedOpens.ts`):
 *
 * 1. At request time (`trackingHttp.trackClick`), `classifyClickRequest`
 *    reduces the request's User-Agent to one coarse `ClickAgent` class. Only
 *    that class crosses into the database layer; the User-Agent is not stored.
 * 2. In the Send lifecycle (`reduceClicked`), `automatedClickReason` combines
 *    that class with the time since the send went out and the send's previous
 *    click. The send row keeps a counter and a first-seen timestamp.
 *
 * Apple's MPP proxy fetches images but does not follow links, so there is no
 * Apple class here and the Apple-network IP rule is not applied: it would
 * reclassify real iPhone users whose traffic leaves through Apple's network.
 * The bare `Mozilla/5.0` User-Agent is still automated on a click, because no
 * browser a person clicks from sends it.
 *
 * Whatever the class, the redirect is served the same way. Classification only
 * changes what is counted.
 */

import { v, type Infer } from 'convex/values';
import { APPLE_PROXY_USER_AGENT, PREFETCH_WINDOW_MS, isScannerUserAgent } from './automatedOpens';

/**
 * The coarse class of the client that followed a tracked link. The validator
 * is the single source; the `clicked` transition argument reuses it.
 */
export const clickAgentValidator = v.union(v.literal('scanner'), v.literal('client'));
export type ClickAgent = Infer<typeof clickAgentValidator>;

/** Why a click was judged automated. */
export type AutomatedClickReason = 'scanner' | 'prefetch' | 'burst';

/**
 * Two different links on one send followed this close together are a scanner
 * walking the message. A person has to return to the email between clicks.
 */
export const CLICK_BURST_WINDOW_MS = 1_000;

/** Reduce a click request to its coarse client class. */
export function classifyClickRequest(request: {
	userAgent: string | null | undefined;
}): ClickAgent {
	const userAgent = (request.userAgent ?? '').trim().toLowerCase();
	if (userAgent === APPLE_PROXY_USER_AGENT) return 'scanner';
	return isScannerUserAgent(userAgent) ? 'scanner' : 'client';
}

/**
 * Decide whether one click is automated, and why. `agent` is absent for
 * clicks reported by a provider webhook rather than our own redirect; those
 * carry no request to judge and keep counting as clicks, as they always have.
 * `previousClick` is the send's latest reader click, if any.
 *
 * The burst rule only catches the second and later links of a burst: the first
 * link was already counted as a reader click when it arrived.
 */
export function automatedClickReason(click: {
	agent: ClickAgent | undefined;
	at: number;
	url: string;
	sentAt: number | undefined;
	previousClick: { url: string; clickedAt: number } | undefined;
}): AutomatedClickReason | null {
	if (click.agent === undefined) return null;
	if (click.agent === 'scanner') return 'scanner';
	if (click.sentAt !== undefined) {
		const sinceSent = click.at - click.sentAt;
		if (sinceSent >= 0 && sinceSent < PREFETCH_WINDOW_MS) return 'prefetch';
	}
	const previous = click.previousClick;
	if (
		previous !== undefined &&
		previous.url !== click.url &&
		Math.abs(click.at - previous.clickedAt) < CLICK_BURST_WINDOW_MS
	) {
		return 'burst';
	}
	return null;
}
