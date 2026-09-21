/**
 * The sender profile panel's pure derivations (plan idea 45).
 *
 * The panel itself is a slide-over full of Convex reads; what lives here is the
 * handful of decisions that have a right and a wrong answer, so they can be
 * tested without mounting anything: how the "search all mail from them" query
 * is spelled, and which single line honestly describes how their mail
 * authenticates.
 *
 * Module scope: no Vue, no Convex, no i18n. Lines carry catalog KEYS and
 * params, resolved at the render boundary.
 */

/** Mirrors the backend's `SenderAuthSummary`, minus the Convex types. */
export interface SenderAuthFacts {
	verdict: 'pass' | 'mixed' | 'unknown';
	checked: number;
	passed: number;
	latest: {
		spf?: string;
		dkim?: string;
		dmarc?: string;
		arcSealer?: string;
	} | null;
}

export interface SenderProfileLine {
	key: string;
	params?: Record<string, string | number>;
}

const KEY_PREFIX = 'components.postbox.postboxSenderProfile.auth';

/**
 * A search that finds this sender's mail and only this sender's mail.
 *
 * The `from:` operator's value ends at the first space, so an address that
 * somehow contains one has to be quoted — the grammar supports
 * `from:"a b@x.example"` and would otherwise silently search for `from:a` plus
 * a stray word.
 */
export function senderSearchQuery(email: string): string {
	const address = email.trim().toLowerCase();
	return /\s|"/.test(address) ? `from:"${address.replace(/"/g, '')}"` : `from:${address}`;
}

/** The reader's search route, pre-filled with that query. */
export function senderSearchLink(email: string): { path: string; query: { q: string } } {
	return { path: '/dashboard/postbox/search', query: { q: senderSearchQuery(email) } };
}

/**
 * One line about how this sender's mail authenticates, over the window the
 * backend actually sampled.
 *
 * Deliberately never claims more than was checked. Nothing recorded reads as
 * "not checked" rather than a reassuring tick — the whole value of an auth line
 * is that it is trustworthy when it does say "authenticated", and a badge that
 * green-lights an unverified sender is worse than no badge.
 */
export function senderAuthLine(auth: SenderAuthFacts): SenderProfileLine {
	if (auth.verdict === 'unknown' || auth.checked === 0) {
		return { key: `${KEY_PREFIX}.unknown` };
	}
	if (auth.verdict === 'pass') {
		// A pass that only exists because a trusted forwarder vouched for it is a
		// different fact, and the panel says which forwarder.
		if (auth.latest?.arcSealer) {
			return { key: `${KEY_PREFIX}.viaForwarder`, params: { sealer: auth.latest.arcSealer } };
		}
		return { key: `${KEY_PREFIX}.pass`, params: { checked: auth.checked } };
	}
	return {
		key: `${KEY_PREFIX}.mixed`,
		params: { failed: auth.checked - auth.passed, checked: auth.checked },
	};
}

/** Colour role for the auth line — the same three states, for the badge. */
export function senderAuthTone(auth: SenderAuthFacts): 'good' | 'warn' | 'muted' {
	if (auth.verdict === 'pass') return 'good';
	if (auth.verdict === 'mixed') return 'warn';
	return 'muted';
}

/**
 * How the message count is worded. Past the backend's scan cap the number is a
 * floor, not a total, and the panel must not present a floor as a count.
 */
export function senderCountLine(count: number, isCapped: boolean): SenderProfileLine {
	const prefix = 'components.postbox.postboxSenderProfile';
	return isCapped
		? { key: `${prefix}.messagesAtLeast`, params: { count } }
		: { key: `${prefix}.messages`, params: { count } };
}
