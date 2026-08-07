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
 * WHAT IS NOT YET A DECLARATION is the DATA each panel then renders — a key
 * presence, a last-event timestamp — which still comes from a per-kind backend
 * query. {@link PANEL_ANSWERS_FOR_KINDS} keeps the gate from outrunning it.
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
 * THE KINDS EACH PANEL'S BACKEND READ CAN ACTUALLY SPEAK FOR — the same
 * discipline `RelayDomainStatus.vue`'s `ANSWERS_FOR_KINDS` carries, and here for
 * the same reason: a gate cannot be more general than the data behind it.
 *
 * The PANEL is chosen by mechanism, which is the D5 half of this work. But each
 * panel then renders numbers that come from a PER-KIND query:
 * `getMandrillFeedbackStatus` is a `MANDRILL_WEBHOOK_KEY` presence read, and
 * `getLastSesEventAt` reads SES's own event table. A sixth kind declaring
 * `setupPanel: 'signed-webhook'` would therefore be shown Mandrill's key
 * presence and Mandrill's last-event timestamp under its own name — a green
 * build, a green suite, and an operator told their webhook is wired when nothing
 * of theirs was ever read.
 *
 * So a kind outside its panel's set draws NO panel rather than another
 * provider's numbers. That is a deliberately visible gap: a provider author who
 * declares the panel and gets nothing on screen goes looking, where one who gets
 * a plausible wrong card does not. Both sets collapse to "every kind that
 * declares this panel" when the two reads are generalised to the ACTIVE
 * transport — one status query answering for whichever kind is routed, instead
 * of `getMandrillFeedbackStatus` and `getLastSesEventAt`.
 *
 * That generalisation is still open, and no seams-plan piece owns it: the
 * feedback registry (D6/P2.1) made the ROUTES general — one dispatcher, a
 * compile-guarded adapter per declaring kind — and deliberately stopped at the
 * HTTP seam. The panels read `delivery/status.ts`, which it never touched. So a
 * second kind of either mechanism has to land the read alongside itself.
 */
const PANEL_ANSWERS_FOR_KINDS: Readonly<Record<SendProviderFeedbackSetupPanel, readonly string[]>> =
	{
		'sns-topic': ['ses'],
		'signed-webhook': ['mandrill'],
	};

/**
 * The setup panel this transport's feedback channel needs, or `undefined` when
 * there is none to draw.
 *
 * FOUR WAYS TO GET `undefined`, all of them correct: the kind has no feedback at
 * all (a bring-your-own SMTP relay), the kind's channel needs nothing from the
 * operator (our own MTA, which we wire ourselves), its ceremony has no panel in
 * this app yet (Resend — see the entry), or the panel it declares is one whose
 * backend read cannot yet speak for this kind (see
 * {@link PANEL_ANSWERS_FOR_KINDS}). `hasProviderFeedback` is checked as well as
 * the descriptor so a channel declared beside a transport that reports nothing
 * can never put a "wire up your feedback" card on screen.
 */
export function providerFeedbackPanel(
	kind: string | null | undefined
): SendProviderFeedbackSetupPanel | undefined {
	const entry = coreSendProviderCatalogEntry(kind ?? undefined);
	if (entry === undefined || !hasProviderFeedbackOf(entry)) return undefined;
	const panel = entry.providerFeedback?.setupPanel;
	if (panel === undefined) return undefined;
	return PANEL_ANSWERS_FOR_KINDS[panel].includes(entry.kind) ? panel : undefined;
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
