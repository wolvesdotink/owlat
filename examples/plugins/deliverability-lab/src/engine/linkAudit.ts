/**
 * Link audit — finds the deliverability and hygiene problems that live in an
 * email's anchors: insecure `http://` links, bare IP/`localhost` hosts, links
 * whose VISIBLE TEXT is itself a different URL than the href (a classic phishing
 * shape), and (advisory) marketing links with no UTM parameters. Pure and
 * deterministic — identical HTML always yields the identical report.
 */

import { scanAnchors, textContent } from './html';
import type { DeliverabilityEmail, Finding, Verdict } from './types';
import { verdictOf } from './types';

export interface LinkAuditReport {
	readonly linkCount: number;
	readonly verdict: Verdict;
	readonly findings: readonly Finding[];
}

/** One anchor: its resolved href and the visible text between the tags. */
interface Anchor {
	readonly href: string;
	readonly text: string;
}

const HREF_RE = /\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/i;

function readHref(rawAttributes: string): string {
	const match = HREF_RE.exec(rawAttributes);
	if (!match?.[1]) return '';
	let value = match[1];
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	return value.trim();
}

function parseAnchors(html: string): Anchor[] {
	return scanAnchors(html).map((anchor) => ({
		href: readHref(anchor.attributes),
		text: textContent(anchor.inner),
	}));
}

/** Extract the host of an href, or null when it is not an absolute http(s) URL. */
function hostOf(value: string): string | null {
	const match = /^https?:\/\/([^/?#]+)/i.exec(value.trim());
	return match?.[1]?.toLowerCase() ?? null;
}

function isBareIpOrLocalhost(host: string): boolean {
	const bare = host.replace(/:\d+$/, '');
	return bare === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare);
}

export function auditLinks(email: DeliverabilityEmail): LinkAuditReport {
	if (!email.html) {
		return { linkCount: 0, verdict: 'pass', findings: [] };
	}

	const anchors = parseAnchors(email.html).filter(
		(anchor) => anchor.href.length > 0 && !anchor.href.startsWith('#')
	);
	const findings: Finding[] = [];
	let insecure = 0;
	let bareHost = 0;
	let mismatched = 0;
	let missingUtm = 0;
	let trackable = 0;

	for (const { href, text } of anchors) {
		if (/^http:\/\//i.test(href)) insecure += 1;

		const targetHost = hostOf(href);
		if (targetHost && isBareIpOrLocalhost(targetHost)) bareHost += 1;

		if (/^https?:\/\//i.test(href)) {
			trackable += 1;
			if (!/[?&]utm_/i.test(href)) missingUtm += 1;
		}

		// Visible text that is itself a URL pointing at a DIFFERENT host than the
		// href is the display/target mismatch that filters and recipients distrust.
		const shownHost = hostOf(text);
		if (targetHost && shownHost && shownHost !== targetHost) mismatched += 1;
	}

	if (insecure > 0) {
		findings.push({
			code: 'insecure_link',
			severity: 'fail',
			message: `${insecure} link(s) use insecure http://; use https:// so clients don't warn.`,
		});
	}
	if (bareHost > 0) {
		findings.push({
			code: 'bare_host_link',
			severity: 'fail',
			message: `${bareHost} link(s) point at a raw IP or localhost, which filters treat as suspicious.`,
		});
	}
	if (mismatched > 0) {
		findings.push({
			code: 'display_target_mismatch',
			severity: 'fail',
			message: `${mismatched} link(s) show one URL but point somewhere else.`,
		});
	}
	if (missingUtm > 0 && trackable > 0) {
		findings.push({
			code: 'missing_utm',
			severity: 'warn',
			message: `${missingUtm} of ${trackable} tracked link(s) are missing utm_ parameters.`,
		});
	}

	return { linkCount: anchors.length, verdict: verdictOf(findings), findings };
}
