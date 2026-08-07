/**
 * THE FEEDBACK CHANNEL a send provider reports through — where its bounces and
 * complaints arrive, and what wiring that up asks of the OPERATOR (the seams
 * plan's D1/D5).
 *
 * A sibling of `./sendProviderCredentialFields` and for the same reason: both
 * are UI-facing descriptor vocabulary that an entry in `./sendProviderCatalog`
 * is written in, and neither is a capability the fail-closed accessors in
 * `./sendProviderCapabilities` read. Import through `./sendProviderCatalog`,
 * which re-exports every name here.
 *
 * DATA ONLY — a route PATH and an env variable NAME. Never a key, never a URL:
 * the absolute endpoint is this deployment's own site URL joined to the path,
 * which only the browser knows.
 */

/**
 * The in-app SETUP CEREMONY a provider's feedback channel needs from the
 * operator — a mechanism, never a vendor.
 *
 *  - `sns-topic`      the endpoint has to be subscribed from the provider's own
 *                     notification service, and the subscription is confirmed by
 *                     a handshake the endpoint answers (AWS SNS).
 *  - `signed-webhook` the operator creates a webhook in the provider's console
 *                     and copies the issued signing key into the deployment, so
 *                     the panel also reports whether that key is present.
 *
 * A KIND WITH FEEDBACK BUT NO PANEL declares no `setupPanel` — see
 * {@link SendProviderFeedbackChannel.setupPanel}, where the two reasons that
 * happens are argued.
 */
export type SendProviderFeedbackSetupPanel = 'sns-topic' | 'signed-webhook';

/**
 * WHERE a transport's feedback arrives, and what wiring it up asks of the
 * operator (the seams plan's D5 — the UI renders descriptors, it doesn't know
 * providers).
 *
 * `hasProviderFeedback` answers whether feedback exists AT ALL, which is what
 * measurement confidence grades on. It cannot answer what the delivery config
 * page has to draw: an SNS subscription and a console webhook with a signing key
 * are different ceremonies with different copy. That used to be a table of kind
 * literals inside `config.vue`, so a sixth provider with real feedback rendered
 * NO panel at all and nothing failed — the gap this descriptor closes.
 *
 * DATA ONLY, like every other field here: a route PATH and an env variable NAME,
 * never a key and never a URL (the absolute endpoint is the deployment's own
 * site URL joined to the path, which only the browser knows).
 */
export interface SendProviderFeedbackChannel {
	/**
	 * The path this provider posts events to, as registered in
	 * `apps/api/convex/http.ts`. Declared rather than derived from the kind: the
	 * route is a URL an operator has already pasted into a provider console, so
	 * it can never be renamed silently by a kind rename (the seams plan's P2.1 —
	 * "routes stay static per kind, URL stability for already-configured
	 * webhooks").
	 */
	readonly webhookPath: string;
	/**
	 * The deployment variable holding the key the endpoint verifies signatures
	 * with, when the ceremony issues one. NAME only — never the value.
	 */
	readonly signingKeyEnvVar?: string;
	/**
	 * The operator-facing setup panel this channel gets, when one exists.
	 *
	 * ABSENT IS A DECLARATION, and it covers two cases the entries spell out
	 * individually: a channel WE wire (our own MTA posts to us with a secret the
	 * installer writes, so there is nothing to show), and a channel whose console
	 * setup this app does not surface yet (Resend's signed webhook — the shipped
	 * delivery page has never had a panel for it, and the key-presence read that
	 * a panel needs is per-kind backend work no plan piece owns yet: the feedback
	 * registry made the ROUTES general, not the STATUS READS behind the panels).
	 */
	readonly setupPanel?: SendProviderFeedbackSetupPanel;
}
