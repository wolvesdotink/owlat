/**
 * Send composition (module) — entry points.
 *
 * The single dispatch surface from `kind` to per-kind composer. Every send
 * producer in the codebase calls one of `composeForSend` / `personalizeSubject`
 * — no producer open-codes its own composition logic.
 *
 * The registry uses TypeScript's `satisfies` check on a `Record<K, ComposerFn>`
 * keyed by every `SendCompositionKind` literal — adding a sixth kind without
 * adding a registry entry is a compile error.
 */

import { POSTAL_ADDRESS_BLOCK_ATTRIBUTE } from '@owlat/shared/brandKitBlocks';
import { htmlToPlainText } from '@owlat/shared/html';

import { composeArchiveSnapshot } from './archive_snapshot';
import { composeAutomation } from './automation';
import { composeCampaign } from './campaign';
import { composeTest } from './test';
import { composeTransactional } from './transactional';
import { addressLines, footerText } from './footer';
import {
	automationVariables,
	personalize,
	personalizeBody,
	withUnsubscribeLink,
} from './personalization';
import type {
	ComposeInput,
	ComposeInputForKind,
	ComposeOutput,
	ComposerOutput,
	SendCompositionKind,
} from './types';

export type {
	AttachmentRef,
	ArchiveSnapshotComposeInput,
	AutomationComposeInput,
	CampaignComposeInput,
	ComposeInput,
	ComposeInputForKind,
	ComposeOutput,
	ComposerOutput,
	ContactInfo,
	SendCompositionKind,
	SendTemplate,
	TestComposeInput,
	TransactionalComposeInput,
} from './types';
export type { TransformConfig } from './transform';

/**
 * Per-kind composers return everything but the `text` alternative — that is
 * resolved centrally in `composeForSend` (template `plainTextContent` first,
 * else a strip of the untracked `html`) so the `text/plain` part stays clean
 * (no tracking pixel / redirect links).
 */
type ComposerFn<K extends SendCompositionKind> = (input: ComposeInputForKind<K>) => ComposerOutput;

type ComposerRegistry = {
	[K in SendCompositionKind]: ComposerFn<K>;
};

const COMPOSERS = {
	campaign: composeCampaign,
	transactional: composeTransactional,
	test: composeTest,
	archive_snapshot: composeArchiveSnapshot,
	automation: composeAutomation,
} as const satisfies ComposerRegistry;

/**
 * Full composition. Used by the worker and by the synchronous dispatch
 * paths (test, automation). Returns the wire-ready envelope plus the
 * `transformConfig` the Node transform half consumes.
 */
export function composeForSend(input: ComposeInput): ComposeOutput {
	const composer = COMPOSERS[input.kind] as ComposerFn<typeof input.kind>;
	const composed = composer(input);
	// The text/plain alternative, in preference order:
	//  1. the template's `plainTextContent` — the author's manual override, or
	//     the body generated from the block document at save time. It is
	//     personalized here with the same variables the subject uses, under the
	//     `plain` escape policy (a text part must NOT be HTML-escaped).
	//  2. a strip of the UNTRACKED html the composer returns (the tracking pixel
	//     + link rewriting happen later, in the Node `transformHtml` half), so
	//     the text part carries no pixel/redirect URL either way. This is why the
	//     text part is built here and not by the MTA's `htmlToPlainText` fallback,
	//     which only ever sees the tracked html. `preserveBreaks` keeps the
	//     paragraph layout a reader expects from an RFC 2046 alternative.
	//
	// The footer `transformHtml` appends to the html is appended here too, so a
	// reader of the text part has the same visible opt-out.
	const stored = input.template.plainTextContent?.trim();
	// A transactional text body resolves its conditions and repeats the way
	// its html does; no other kind stores region markers.
	const personalizeText = input.kind === 'transactional' ? personalizeBody : personalize;
	const body = stored
		? personalizeText(stored, bodyVariablesFor(input), { escape: 'plain' })
		: htmlToPlainText(composed.html, { preserveBreaks: true });
	const config = composed.transformConfig;
	const lines = addressLines(config?.senderAddress);
	const text =
		config?.unsubscribeUrl && config.preferenceUrl
			? `${body.trimEnd()}\n\n${footerText({
					unsubscribeUrl: config.unsubscribeUrl,
					preferenceUrl: config.preferenceUrl,
					language: config.footerLanguage,
					// Decided on the text part itself: an author-written text body may
					// leave out the address the html block prints.
					senderAddress: printsEveryLine(body, lines) ? undefined : config.senderAddress,
				})}`
			: body;
	// Compared on the rendered text, so bold or a link inside an address line
	// still counts as printing it.
	const htmlPrintsAddress =
		POSTAL_ADDRESS_BLOCK_RE.test(composed.html) &&
		printsEveryLine(htmlToPlainText(composed.html, { preserveBreaks: true }), lines);
	if (!config || !htmlPrintsAddress) return { ...composed, text };
	const { senderAddress: _printedByTheBody, ...transformConfig } = config;
	return { ...composed, transformConfig, text };
}

/**
 * A rendered element carrying the postal-address marker. Anchored on a tag so
 * the attribute name written as text in the body does not count. Authors cannot
 * set the attribute themselves: the text and raw-HTML sanitizers drop it, so
 * only the renderer's brand kit footer block emits it.
 */
const POSTAL_ADDRESS_BLOCK_RE = new RegExp(
	`<[a-z][^>]*\\s${POSTAL_ADDRESS_BLOCK_ATTRIBUTE}(?=[\\s=/>])`,
	'i'
);

/**
 * Whether a body already prints every line of the sender's address, so the
 * footer can keep only its two links. The html part counts only with the brand
 * kit footer block's marker AND the lines still in it: an author who edited the
 * address out of the block keeps the flag, not the address. Exact lines, not a
 * guess at what looks like an address. Seed shadow copies go through here too
 * and stay identical to the mail they mirror.
 */
function printsEveryLine(body: string, lines: readonly string[]): boolean {
	// Runs of spaces, tabs and no-break spaces count as one space.
	const spaced = (text: string) => text.replace(/[^\S\n]+/g, ' ');
	const text = spaced(body);
	return lines.length > 0 && lines.every((line) => text.includes(spaced(line)));
}

/** The personalization variables this send kind substitutes into its subject. */
function variablesFor(input: ComposeInput): Record<string, unknown> {
	switch (input.kind) {
		case 'campaign':
		case 'automation':
			return input.contactInfo;
		case 'transactional':
			return input.dataVariables ?? {};
		case 'test':
			return input.sampleContact;
		case 'archive_snapshot':
			return { email: '', firstName: '', lastName: '' };
	}
}

/**
 * The variables the body (html and text part) is personalized with: the
 * subject's, plus `{{unsubscribe_link}}` where the send has a footer. Each html
 * composer adds the link the same way, so both parts resolve the same values.
 */
function bodyVariablesFor(input: ComposeInput): Record<string, unknown> {
	switch (input.kind) {
		case 'campaign':
		case 'transactional':
			return withUnsubscribeLink(variablesFor(input), input.unsubscribeUrl);
		case 'test':
			return withUnsubscribeLink(input.sampleContact, input.footer?.unsubscribeUrl);
		case 'automation':
			return automationVariables(input.contactInfo);
		case 'archive_snapshot':
			return variablesFor(input);
	}
}

/**
 * Subject-only personalization shorthand.
 *
 * Used by the campaign orchestrator to write `emailSends.personalizedSubject`
 * (the snapshot field) at enqueue time, and by test sends to compute the
 * personalized portion before the producer prepends the `[TEST]` indicator.
 *
 * Subjects always use `escape: 'header'` — email clients do not render HTML
 * in subject lines (so HTML escaping would surface as literal entity strings
 * in the recipient's inbox), and the header policy strips CR/LF so a
 * personalized value cannot inject a second mail header (RFC 5322 §2.2).
 */
export function personalizeSubject(input: ComposeInput): string {
	return personalize(input.template.subject, variablesFor(input), { escape: 'header' });
}
