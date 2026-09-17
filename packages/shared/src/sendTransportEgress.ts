/**
 * THE OUTBOUND NETWORK PATH a send transport takes — the one thing about a
 * transport that a hosting provider, not the operator, decides.
 *
 * A sibling of `./sendProviderFeedback` and for the same reason: a single
 * capability with enough to say about itself that the catalog's type file
 * should not carry it. Read it off an entry with `egressOf` in
 * `./sendProviderCapabilities`; import the name through `./sendProviderCatalog`,
 * which re-exports it.
 *
 * It exists because a closed port is invisible from inside the app: the port
 * checks (`./networkPorts`) ask each configured transport which path it needs
 * open, and answer "is a blocked 25 this instance's problem?" from the
 * declaration rather than from the transport's name.
 */

/**
 * The network path this transport dials on the way out — the one thing a
 * hosting provider can close underneath it.
 *
 *  - `recipient-mx` opens TCP/25 to each recipient's own mail server. Direct
 *                   delivery, and the port stock VPS products block by default.
 *  - `smtp-relay`   opens one submission connection to a relay the operator
 *                   configured (587, or 465 when the relay wants implicit TLS).
 *  - `https-api`    posts over 443 like any other API integration.
 *
 * Absent ⇒ `https-api`. That is what every generated (plugin) entry is, and it
 * is the reading that never claims a mail port an instance may not have — the
 * port checks derive "is 25 required here?" from this, and a wrong `recipient-mx`
 * would paint a red row on an instance that never dials an MX.
 */
export type SendTransportEgress = 'recipient-mx' | 'smtp-relay' | 'https-api';
