/**
 * The network ports an Owlat instance depends on, and which of them THIS
 * instance actually needs.
 *
 * A self-hosted install fails in ways that look like application bugs but are
 * really a closed port: a VPS provider that blocks outbound 993 turns
 * "connect an existing mailbox" into a timeout with no explanation, and one
 * that refuses port 53 to anything but its own resolver makes every blocklist
 * lookup unmeasurable, which halts sending. The operator cannot see any of
 * that from inside the app, so the catalog below names each port, the feature
 * that stops working without it, and the target a probe may dial to find out.
 *
 * Pure data + derivation: the updater owns the actual sockets (it is the only
 * component on the host network), the admin UI owns the presentation, and both
 * read their vocabulary from here so neither can invent a port the other does
 * not know.
 */

import { egressOf } from './sendProviderCapabilities';
import { coreSendProviderCatalogEntry } from './sendProviderCatalog';

/** Which way through the firewall a check exercises. */
export type PortDirection = 'inbound' | 'outbound';

/**
 * How a check is performed. `tcp` opens a connection and closes it without
 * writing a byte; `dns` resolves a well-known domain's MX, because a resolver
 * that accepts a connection still tells you nothing about whether it answers —
 * and MX resolution is what delivery, domain verification and blocklist
 * lookups all sit on.
 */
export type PortProbeKind = 'tcp' | 'dns';

export type PortCheckId =
	| 'inbound-https'
	| 'inbound-http'
	| 'inbound-smtp'
	| 'inbound-imaps'
	| 'outbound-smtp'
	| 'outbound-submission'
	| 'outbound-smtps'
	| 'outbound-imaps'
	| 'outbound-https'
	| 'outbound-dns';

export interface PortCheckSpec {
	id: PortCheckId;
	direction: PortDirection;
	port: number;
	/**
	 * The protocol's own name. Data, not copy: HTTPS is HTTPS in every locale,
	 * and a translatable string per protocol is ten keys per language that can
	 * only ever be translated back to themselves.
	 */
	protocol: string;
	probe: PortProbeKind;
	/**
	 * Outbound: the public host the probe dials — deliberately a host the
	 * instance already talks to in normal operation, so a check reveals nothing
	 * new about the deployment. Inbound: the compose service that must answer,
	 * reachable from the updater over the project network.
	 */
	target: string;
}

/**
 * Every port Owlat can depend on, in the order the UI lists them.
 *
 * Module-private on purpose: the catalog is only ever read THROUGH
 * `selectPortChecks`, which annotates each entry with whether this instance
 * needs it. A caller holding the bare list would have the port and not the
 * judgement, which is the half that makes a row mean something.
 *
 * Inbound entries dial a compose SERVICE, which proves the listener is up and
 * bound — not that the internet can reach it. Nothing running on this host can
 * prove the latter (a packet to our own public address never leaves it), so the
 * UI says so rather than implying a reachability guarantee it cannot make.
 */
const PORT_CHECKS: readonly PortCheckSpec[] = Object.freeze([
	{
		id: 'inbound-https',
		protocol: 'HTTPS',
		direction: 'inbound',
		port: 443,
		probe: 'tcp',
		target: 'caddy',
	},
	{
		id: 'inbound-http',
		protocol: 'HTTP',
		direction: 'inbound',
		port: 80,
		probe: 'tcp',
		target: 'caddy',
	},
	{
		id: 'inbound-smtp',
		protocol: 'SMTP',
		direction: 'inbound',
		port: 25,
		probe: 'tcp',
		target: 'mta',
	},
	{
		id: 'inbound-imaps',
		protocol: 'IMAPS',
		direction: 'inbound',
		port: 993,
		probe: 'tcp',
		target: 'imap',
	},
	{
		id: 'outbound-smtp',
		protocol: 'SMTP',
		direction: 'outbound',
		port: 25,
		probe: 'tcp',
		target: 'gmail-smtp-in.l.google.com',
	},
	{
		id: 'outbound-submission',
		protocol: 'Submission',
		direction: 'outbound',
		port: 587,
		probe: 'tcp',
		target: 'smtp.gmail.com',
	},
	{
		id: 'outbound-smtps',
		protocol: 'SMTPS',
		direction: 'outbound',
		port: 465,
		probe: 'tcp',
		target: 'smtp.gmail.com',
	},
	{
		id: 'outbound-imaps',
		protocol: 'IMAPS',
		direction: 'outbound',
		port: 993,
		probe: 'tcp',
		target: 'imap.gmail.com',
	},
	{
		id: 'outbound-https',
		protocol: 'HTTPS',
		direction: 'outbound',
		port: 443,
		probe: 'tcp',
		target: 'ghcr.io',
	},
	{
		id: 'outbound-dns',
		protocol: 'DNS',
		direction: 'outbound',
		port: 53,
		probe: 'dns',
		target: 'gmail.com',
	},
]);

/**
 * What a probe concluded.
 *
 * `blocked` is the interesting one: the connection neither completed nor was
 * refused, which is what a firewall that drops packets looks like from here.
 * A REFUSED connection means something answered, so the path is open and only
 * the listener is missing — a different fix, hence a different word.
 */
export type PortCheckStatus = 'open' | 'blocked' | 'refused' | 'error' | 'skipped';

/**
 * Why a check is (or is not) part of this instance's contract.
 *
 * `required` means a feature that is switched ON needs the port. `optional`
 * means the port belongs to a feature this instance does not use, so a failure
 * is information rather than a fault — listing it anyway is what lets an
 * operator check a port BEFORE turning the feature on.
 */
export type PortRelevance = 'required' | 'optional';

export interface SelectedPortCheck extends PortCheckSpec {
	relevance: PortRelevance;
}

/** The instance state that decides which ports are required. */
export interface PortRelevanceContext {
	/** Applied compose profiles (COMPOSE_PROFILES in the host `.env`). */
	profiles: readonly string[];
	/** `EMAIL_PROVIDER` — the configured send transport kind. */
	deliveryProvider?: string | null;
}

function requiredIds(context: PortRelevanceContext): ReadonlySet<PortCheckId> {
	const profiles = new Set(context.profiles);
	const provider = context.deliveryProvider ?? undefined;
	const ids = new Set<PortCheckId>([
		// The app itself, plus image pulls, update checks and every provider API.
		'inbound-https',
		'outbound-https',
		// MX lookups, SPF/DKIM/DMARC verification and blocklist checks.
		'outbound-dns',
	]);
	// Caddy answers the ACME HTTP-01 challenge on 80; without the tls profile
	// the operator terminates TLS somewhere else and owns that port there.
	if (profiles.has('tls')) ids.add('inbound-http');
	// The built-in MTA receives mail and bounces on 25.
	if (profiles.has('mta')) ids.add('inbound-smtp');
	// Mail clients reach the built-in mailbox over IMAPS.
	if (profiles.has('personal-mail')) ids.add('inbound-imaps');
	// Which mail port the configured transport needs is a property OF THE
	// TRANSPORT, declared on its catalog entry — not something to rediscover by
	// name here. A relay is reached on submission; 465 stays optional because a
	// relay uses one port or the other and the catalog cannot know which.
	const egress = egressOf(coreSendProviderCatalogEntry(provider));
	if (egress === 'recipient-mx') ids.add('outbound-smtp');
	if (egress === 'smtp-relay') ids.add('outbound-submission');
	// Connecting somebody's existing mailbox dials THEIR provider: IMAP over
	// 993 to read, implicit-TLS SMTP over 465 to send.
	if (profiles.has('external-mail')) {
		ids.add('outbound-imaps');
		ids.add('outbound-smtps');
	}
	return ids;
}

/** The catalog, annotated with whether this instance's configuration needs each port. */
export function selectPortChecks(context: PortRelevanceContext): SelectedPortCheck[] {
	const required = requiredIds(context);
	return PORT_CHECKS.map((spec) => ({
		...spec,
		relevance: required.has(spec.id) ? 'required' : 'optional',
	}));
}

export interface PortCheckOutcome {
	id: PortCheckId;
	status: PortCheckStatus;
	relevance: PortRelevance;
}

export type PortChecksVerdict = 'ok' | 'degraded' | 'unknown';

/**
 * One word for the whole card.
 *
 * Only REQUIRED checks can degrade an instance — an optional port that is shut
 * is the provider's default, not a fault. `unknown` covers the probe failing
 * for its own reasons (no DNS at all, the sidecar erroring), which must not be
 * reported as a closed port: "we could not tell" and "it is blocked" send the
 * operator to different places.
 */
export function summarizePortChecks(outcomes: readonly PortCheckOutcome[]): PortChecksVerdict {
	const required = outcomes.filter((outcome) => outcome.relevance === 'required');
	if (required.some((outcome) => outcome.status === 'blocked' || outcome.status === 'refused')) {
		return 'degraded';
	}
	if (required.some((outcome) => outcome.status === 'error' || outcome.status === 'skipped')) {
		return 'unknown';
	}
	return 'ok';
}
