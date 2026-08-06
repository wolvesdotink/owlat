/**
 * WHICH FEEDBACK PANEL THE DELIVERY CONFIG PAGE DRAWS, and what endpoint it
 * shows — derived from the active transport's catalog entry (the seams plan's
 * D2/D5: capabilities, not identity).
 *
 * The page used to ask `status.provider === 'ses'` and `=== 'mandrill'`, which
 * meant a provider with a real feedback channel got no panel, no endpoint and no
 * explanation until somebody edited a `.vue` file. Both answers are now
 * declarations on the entry: `hasProviderFeedback` says there is feedback at
 * all, and `providerFeedback` says where it arrives and what wiring it up asks
 * of the operator.
 *
 * PURE, and in `~/utils` rather than inline in the page, because this is the one
 * behaviour change P1.2 makes to a shipped dashboard: a mistyped path or a
 * missing declaration would make a live panel (and its polling query) appear or
 * vanish with nothing failing. Here it is a unit test —
 * `__tests__/providerFeedbackPanel.test.ts` pins the panel and the endpoint for
 * every kind the catalog declares.
 */

import {
	coreSendProviderCatalogEntry,
	hasProviderFeedbackOf,
	type SendProviderFeedbackSetupPanel,
} from '@owlat/shared/sendProviderCatalog';

export type { SendProviderFeedbackSetupPanel };

/**
 * The setup panel this transport's feedback channel needs, or `undefined` when
 * there is none to draw.
 *
 * THREE WAYS TO GET `undefined`, all of them correct: the kind has no feedback
 * at all (a bring-your-own SMTP relay), the kind's channel needs nothing from
 * the operator (our own MTA, which we wire ourselves), or its ceremony has no
 * panel in this app yet (Resend — see the entry). `hasProviderFeedback` is
 * checked as well as the descriptor so a channel declared beside a transport
 * that reports nothing can never put a "wire up your feedback" card on screen.
 */
export function providerFeedbackPanel(
	kind: string | null | undefined
): SendProviderFeedbackSetupPanel | undefined {
	const entry = coreSendProviderCatalogEntry(kind ?? undefined);
	if (entry === undefined || !hasProviderFeedbackOf(entry)) return undefined;
	return entry.providerFeedback?.setupPanel;
}

/**
 * The ABSOLUTE endpoint the provider posts to — the deployment's own site URL
 * joined to the path the entry declares.
 *
 * `''` when either half is unknown, and never a relative path: an SNS HTTPS
 * subscription cannot use one, so the page hides the copy block behind a "site
 * URL not configured" hint rather than handing the operator a broken value.
 */
export function providerFeedbackWebhookUrl(
	kind: string | null | undefined,
	siteUrl: string | undefined
): string {
	const path = coreSendProviderCatalogEntry(kind ?? undefined)?.providerFeedback?.webhookPath;
	if (path === undefined || !siteUrl) return '';
	return `${siteUrl.replace(/\/$/, '')}${path}`;
}
