/**
 * Deterministic pre-send checks for the Postbox composer (no model, no flag).
 *
 * The only draft self-check the composer had was the AI coach: manual,
 * `ai`-flag-gated, and absent entirely on a self-hosted instance with AI off.
 * The mistakes that cost the most — sending with no subject, with a `[TODO]`
 * still in the body, with `{{firstName}}` never filled in, with a link whose
 * text names one site and whose href points at another — need no model at all.
 *
 * Contract, deliberately narrow:
 *   • ADVISORY. This module never blocks a send. The composer renders the
 *     findings as a quiet chip next to Send; the replay-confirm dialog is
 *     reserved for the irreversible mistakes (a send that will fail DMARC, a
 *     missing attachment).
 *   • QUIET WHEN UNSURE. Every check only fires on evidence, and only on the
 *     FRESH half of the body — a `[TODO]` inside the quoted original belongs to
 *     its author. A check that misfires trains people to ignore all of them.
 *   • MODULE SCOPE. Findings carry catalog KEYS and params; `useI18n` is called
 *     at the render boundary, never here.
 */

import { clipForDisplay, draftPlainText, draftTextParts } from '~/utils/postboxDraftText';

export type PreflightCheckId = 'emptySubject' | 'placeholder' | 'unfilledVariable' | 'linkMismatch';

export interface PreflightFinding {
	id: PreflightCheckId;
	/** Catalog key, resolved with `t()` by the component that renders it. */
	key: string;
	/** Interpolation params for `key`, already truncated for display. */
	params?: Record<string, string>;
}

export interface PreflightInput {
	subject: string;
	bodyHtml: string;
}

/** One catalog entry per check, so the copy can't drift from the check list. */
const KEY_PREFIX = 'shared.postbox.preflight';

/**
 * Leftover authoring markers. Bracketed forms match case-insensitively
 * (`[todo: numbers]` is as unfinished as `[TODO]`); the bare words only match
 * in caps, so "a todo list" and the surname "Tbd" stay quiet.
 */
const PLACEHOLDER_PATTERNS = [
	/\[\s*(?:TODO|FIXME|TBD|XXX)\b[^\]]{0,60}\]/i,
	/\b(?:TODO|FIXME|TBD|XXX)\b/,
];

/** `{{firstName}}` — a snippet variable that was inserted and never filled. */
const UNFILLED_VARIABLE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/;

const ANCHOR = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

/** A bare hostname with at least one dot and an alphabetic TLD. */
const HOSTNAME = /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})/i;

/**
 * The comparable host of an `href`. Null for anything that isn't an absolute
 * http(s) URL — a `mailto:`, an anchor, a relative path — because there is no
 * host to disagree with.
 */
function hrefHost(href: string): string | null {
	const value = href.trim();
	if (!/^https?:\/\//i.test(value)) return null;
	const withoutScheme = value.replace(/^https?:\/\//i, '');
	const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
	const host = authority.split('@').pop() ?? '';
	return normalizeHost(host.split(':')[0] ?? '');
}

function normalizeHost(host: string): string | null {
	const lower = host.trim().toLowerCase().replace(/\.$/, '');
	if (!lower || !lower.includes('.')) return null;
	return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/** The host an anchor's own text claims, when its text names one at all. */
function claimedHost(text: string): string | null {
	const plain = text.replace(/\s+/g, ' ').trim();
	// An address is a recipient, not a destination claim.
	if (!plain || plain.includes('@')) return null;
	const match = HOSTNAME.exec(plain);
	return match?.[1] ? normalizeHost(match[1]) : null;
}

/**
 * Same site? Equal hosts, or one a subdomain of the other — anchor text saying
 * `example.com` for a link to `eu.example.com` is not a deception, and flagging
 * it would be the kind of noise that gets the whole chip ignored.
 */
function sameSite(a: string, b: string): boolean {
	return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** The first anchor whose visible text names a different site than its href. */
function findLinkMismatch(freshHtml: string): PreflightFinding | null {
	ANCHOR.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ANCHOR.exec(freshHtml)) !== null) {
		const href = match[1] ?? match[2] ?? match[3] ?? '';
		const host = hrefHost(href);
		if (!host) continue;
		const text = claimedHost(draftPlainText(match[4] ?? ''));
		if (!text || sameSite(text, host)) continue;
		return {
			id: 'linkMismatch',
			key: `${KEY_PREFIX}.linkMismatch`,
			params: { text: clipForDisplay(text), host: clipForDisplay(host) },
		};
	}
	return null;
}

/**
 * Run every deterministic check over a draft. Returns findings in a stable
 * order (the order the checks are declared), at most one per check.
 */
export function preflightDraft(input: PreflightInput): PreflightFinding[] {
	const findings: PreflightFinding[] = [];
	const body = draftTextParts(input.bodyHtml);

	if (input.subject.trim().length === 0) {
		findings.push({ id: 'emptySubject', key: `${KEY_PREFIX}.emptySubject` });
	}

	const haystack = `${input.subject} ${body.fresh}`;
	for (const pattern of PLACEHOLDER_PATTERNS) {
		const hit = pattern.exec(haystack);
		if (hit) {
			findings.push({
				id: 'placeholder',
				key: `${KEY_PREFIX}.placeholder`,
				params: { token: clipForDisplay(hit[0]) },
			});
			break;
		}
	}

	const variable = UNFILLED_VARIABLE.exec(haystack);
	if (variable?.[1]) {
		findings.push({
			id: 'unfilledVariable',
			key: `${KEY_PREFIX}.unfilledVariable`,
			params: { name: clipForDisplay(variable[1]) },
		});
	}

	const mismatch = findLinkMismatch(body.freshHtml);
	if (mismatch) findings.push(mismatch);

	return findings;
}
