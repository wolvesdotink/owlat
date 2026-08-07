/**
 * The DOMAIN-IDENTITY half of a bundled send transport (the seams plan's P3.2):
 * what a plugin relay is asked about a sending domain, and what it may answer.
 *
 * Split out of `./sendTransport` for the same reason `./sendTransportFeedback`
 * is: a different conversation with a different actor. The send contract is
 * Owlat calling a plugin to put one message on the wire; this one is Owlat
 * asking a provider whether a CUSTOMER'S OWN DOMAIN may be signed and relayed by
 * it. The manifest DESCRIPTOR that declares the module
 * ({@link PluginSendTransportDomainIdentityDefinition}) stays beside the
 * transport definition it hangs off.
 *
 * THE SPLIT OF RESPONSIBILITY, and it is the same one the feedback half draws.
 * The plugin owns the PROVIDER CONVERSATION — one API call, its credentials, its
 * response shape — and returns observations. The host owns everything that
 * decides anything:
 *
 *  - the VERDICT. `status` is not declarable. The host derives it from the three
 *    observations below, so "verified" always means the same thing across every
 *    relay tier, and a module cannot report a domain verified while telling us
 *    its DKIM record is invalid.
 *  - the FRESHNESS BOUND. How long an observation still licenses handing a From
 *    domain to a third party is a host constant
 *    (`PLUGIN_RELAY_PROOF_MAX_AGE_MS` in
 *    `apps/api/convex/domains/providers/plugin/`), not a manifest field: a
 *    declarable window is a declarable weakening of the one rule that limits the
 *    blast radius of an identity revoked at the provider.
 *  - the ROW. Where the identity lives, what a failed call may overwrite, and
 *    when to ask again are all host decisions — see that folder.
 *
 * A module that throws, hangs, or answers nonsense therefore costs the relay its
 * proof (fail closed: the domain is not relayed) and never the other way round.
 */

import type { PluginSendTransportConfig, PluginStaticModuleExport } from './sendTransport';

/**
 * The sending-domain identity half of a send-transport bundle (the seams plan's
 * D5: send module + webhook + domain identity travel together).
 *
 * DECLARING ONE IS the catalog's `domainVerification: 'api'` for this kind — one
 * fact stated once, exactly as {@link PluginSendTransportDefinition.webhook} is
 * `hasProviderFeedback: true`. A boolean beside it could only ever disagree, and
 * the disagreement is expensive in this direction: `api` is a PROMISE that a
 * proof exists, read by the routing gate that decides whether a From domain may
 * be relayed at all and by the alignment pre-flight that holds the ramp at s=0
 * until a second arm can be described.
 *
 * AT MOST ONE PER TRANSPORT, and it is scoped to the transport rather than to
 * the plugin (unlike the feedback webhook, which the route surface keys by
 * plugin id): two transports of one plugin are two providers as far as a
 * sending domain is concerned, each with its own account, credentials and
 * identity rows.
 */
export interface PluginSendTransportDomainIdentityDefinition {
	/**
	 * The module that talks to the provider's identity API.
	 *
	 * ISOLATE-SAFE, like the webhook half and unlike the send half: the generated
	 * registry is imported by `domains/providers/`, which the ENQUEUE path reads
	 * to answer "may this domain be relayed?". So this module must not import Node
	 * builtins — its two calls are HTTP, and `fetch` is available in both runtimes
	 * that load it. (Nothing CALLS it from a transaction; Convex forbids network
	 * access there. It is the import graph that has to stay isolate-clean.)
	 */
	readonly module: PluginStaticModuleExport;
}

/**
 * One published record's verdict, as the provider reports it.
 *
 * `error` is provider free text kept for an operator log line only — never
 * rendered as guidance and never parsed.
 */
export interface PluginDomainRecordVerdict {
	readonly isValid: boolean;
	readonly error?: string;
}

/**
 * What the provider currently OBSERVES about one sending domain.
 *
 * Deliberately observations rather than a conclusion — see the file header for
 * why the host derives the status. All five fields are required: an absent
 * observation and a negative one are the same answer here (the domain is not
 * provably relayable), and making that explicit stops a partial response object
 * from reading as a partial proof.
 */
export interface PluginDomainIdentityState {
	/**
	 * Has the provider confirmed the deployment OWNS this domain — the ceremony
	 * that is not SPF/DKIM (a verification TXT, a mailbox challenge, a console
	 * click)? False for a domain still waiting on it.
	 */
	readonly isOwnershipVerified: boolean;
	/** The provider's own verdict on the published SPF record. */
	readonly spf: PluginDomainRecordVerdict;
	/** The provider's own verdict on the published DKIM record. */
	readonly dkim: PluginDomainRecordVerdict;
	/**
	 * The DKIM selectors this provider signs the domain's mail under, as the host
	 * would have to resolve them in DNS.
	 *
	 * Carried on the STATE rather than declared in the manifest because both
	 * shapes are real: a provider with one shared account-independent selector
	 * (Mandrill's `mandrill`) returns the same value for every domain, while one
	 * that mints per-domain CNAME tokens (SES's three) can only answer after
	 * registration. A declaration would have served the first and lied for the
	 * second.
	 *
	 * THIS IS THE REFERENCE ARM'S DNS, and the only reason the host asks: the
	 * dual-transport alignment pre-flight resolves these live and compares them
	 * against the own MTA's. An empty list means "we cannot describe this domain's
	 * signing identity", which the pre-flight reads as `unknown` — a HOLD on the
	 * ramp, never an opened gate.
	 */
	readonly dkimSelectors: readonly string[];
	/**
	 * The SPF mechanisms the domain must authorise for this provider (e.g.
	 * `include:spf.example.net`), same reasoning and same consumer as
	 * {@link dkimSelectors}.
	 */
	readonly spfMechanisms: readonly string[];
}

/**
 * The outcome of one identity call, as THREE distinguishable answers — because
 * the host's write rules differ for each and no host can tell them apart from a
 * thrown error.
 *
 *  - `ok`          an observation. The only one that is EVIDENCE: it is the only
 *                  outcome that refreshes the proof's age.
 *  - `auth_failed` the provider rejected this deployment's credential. Terminal
 *                  until an operator fixes it, and recorded as such — but it does
 *                  NOT overwrite the SPF/DKIM verdicts already stored, because a
 *                  bad API key is not evidence that the operator's DNS stopped
 *                  being valid.
 *  - `unavailable` the provider did not answer. Evidence of nothing: the identity
 *                  is left untouched and only the retry moves, so a long outage
 *                  cannot keep a stale proof alive by being unable to re-confirm
 *                  it.
 *
 * A module that THROWS instead of returning one of these is treated as
 * `unavailable`: the host cannot distinguish a bug from an outage, and the
 * conservative reading is the one that neither condemns a credential nor
 * refreshes a proof.
 */
export type PluginDomainIdentityResult =
	| { readonly outcome: 'ok'; readonly state: PluginDomainIdentityState }
	| { readonly outcome: 'auth_failed'; readonly error: string }
	| { readonly outcome: 'unavailable'; readonly error: string };

/** Most DKIM selectors or SPF mechanisms one state may carry. */
export const PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACTS = 8;

/** Longest selector or mechanism string the host will store and resolve. */
export const PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACT_LENGTH = 255;

/** Longest provider error text kept for an operator log line. */
export const PLUGIN_DOMAIN_IDENTITY_MAX_ERROR_LENGTH = 500;

/**
 * The executable half of a plugin's sending-domain identity.
 *
 * Two calls, and the split between them is the same one every identity API
 * draws: `registerDomain` is the WRITE (create the identity at the provider,
 * idempotently — the host re-registers on an operator's explicit repair), and
 * `checkDomain` is the READ the host repeats on its own schedule to keep the
 * proof fresh.
 *
 * BOTH ARE HANDED THE TRANSPORT'S RESOLVED CONFIGURATION and must read their
 * credentials from it rather than from `process.env`, for the reason spelled out
 * on {@link PluginSendTransportConfig}: an environment read resolves the
 * deployment-default instance whichever instance the caller meant.
 *
 * Neither may be slow: the host calls them from a scheduled action with a bounded
 * budget, and a hung call is an unrefreshed proof that ages out.
 */
export interface PluginSendTransportDomainIdentityModule {
	registerDomain(
		domain: string,
		config: PluginSendTransportConfig
	): Promise<PluginDomainIdentityResult>;
	checkDomain(
		domain: string,
		config: PluginSendTransportConfig
	): Promise<PluginDomainIdentityResult>;
}
