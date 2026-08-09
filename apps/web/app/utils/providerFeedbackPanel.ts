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
 * `undefined` means the kind has no feedback at all, its channel needs nothing
 * from the operator, or the catalog intentionally declares no ceremony. Every
 * declared panel is supported by the generic transport-keyed status query.
 * `hasProviderFeedback` is checked as well as the descriptor so a channel
 * declared beside a transport that reports nothing can never put a "wire up
 * your feedback" card on screen.
 */
export function providerFeedbackPanel(
	kind: string | null | undefined
): SendProviderFeedbackSetupPanel | undefined {
	const entry = coreSendProviderCatalogEntry(kind ?? undefined);
	if (entry === undefined || !hasProviderFeedbackOf(entry)) return undefined;
	const panel = entry.providerFeedback?.setupPanel;
	if (panel === undefined) return undefined;
	return panel;
}

/**
 * The NAME of the deployment variable holding this transport's webhook signing
 * key, or `undefined` when its ceremony issues none.
 *
 * NAME only — never a value; `getStatus` and `getProviderFeedbackStatus` return
 * presence booleans and nothing else. The panel renders this beside a
 * present/missing chip, so reading it from the ACTIVE kind's entry rather than
 * from the panel's markup is the whole point: a `signed-webhook` card that
 * hardcodes one vendor's variable tells every other vendor's operator to set the
 * wrong one, and the chip — computed from the backend's own missing-variable
 * list — then never clears.
 */
export function providerFeedbackSigningKeyEnvVar(
	kind: string | null | undefined
): string | undefined {
	return coreSendProviderCatalogEntry(kind ?? undefined)?.providerFeedback?.signingKeyEnvVar;
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
