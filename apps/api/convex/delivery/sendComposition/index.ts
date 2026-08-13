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

import { composeArchiveSnapshot } from './archive_snapshot';
import { composeAutomation } from './automation';
import { composeCampaign } from './campaign';
import { composeTest } from './test';
import { composeTransactional } from './transactional';
import { personalize } from './personalization';
import { htmlToPlainText } from './plainText';
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
	//     the text part carries no pixel/redirect URL either way.
	const stored = input.template.plainTextContent?.trim();
	const text = stored
		? personalize(stored, variablesFor(input), { escape: 'plain' })
		: htmlToPlainText(composed.html);
	return { ...composed, text };
}

/** The personalization variables this send kind substitutes into its content. */
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
