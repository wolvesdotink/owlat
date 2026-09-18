/**
 * Route phase: turn a recipient into an MX list and a provider shaping policy.
 *
 * MX routing, DANE discovery, provider shaping, and queue throttling all read
 * one immutable destination snapshot — the sender never performs an independent
 * MX lookup after dispatch has acquired a provider bucket. A destination that
 * cannot be delivered to at all (temporary DNS failure, NXDOMAIN, Null MX)
 * short-circuits into a finished {@link EmailJobResult} instead of a route.
 */

import type Redis from 'ioredis';
import { strictestOutboundTlsMode } from '@owlat/shared';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { MtaConfig } from '../../config.js';
import type { DestinationProviderProfile, EmailJobResult } from '../../types.js';
import { getProfile } from '../../config/ispProfiles.js';
import { extractDomain } from '../../queue/groups.js';
import type { DaneMxDestination } from '../daneMxResolver.js';
import {
	providerFromMxHostnames,
	resolveDestinationSnapshot,
	type DestinationSnapshot,
} from '../destinationProvider.js';

/** The provider-shaping subset the send path applies to every connection. */
export type DeliveryProviderPolicy = Pick<
	DestinationProviderProfile,
	'tlsMode' | 'maxConnections' | 'maxDeliveriesPerConnection'
>;

/** A resolved, immutable delivery route for one recipient domain. */
export interface DeliveryRoute {
	recipientDomain: string;
	/** MX exchanges in priority order. */
	mxHosts: string[];
	/** Provider classified from the ACTUAL MX set; scopes the connection caps. */
	routeProvider: DestinationProviderKey;
	providerPolicy: DeliveryProviderPolicy;
	/** DNSSEC-authenticated destinations from the same discovery, by hostname. */
	daneDestinations: Map<string, DaneMxDestination>;
	/** False only when report-only DANE discovery failed and normal DNS was used. */
	daneDiscoveryAuthenticated: boolean;
}

export type RouteResolution =
	| { kind: 'route'; route: DeliveryRoute }
	| { kind: 'undeliverable'; result: EmailJobResult };

/**
 * Reconcile the snapshot's provider profile with the one the live MX set names,
 * strictest wins. This defensive step protects hand-built/legacy snapshots and
 * reverse migrations. Connection scope always follows the actual MX set, so a
 * stale known provider can never poison its shared bucket.
 */
function strictestDeliveryProviderPolicy(
	first: DestinationProviderProfile,
	second: DestinationProviderProfile
): DeliveryProviderPolicy {
	return {
		tlsMode: strictestOutboundTlsMode(first.tlsMode, second.tlsMode),
		maxConnections: Math.min(first.maxConnections, second.maxConnections),
		maxDeliveriesPerConnection: Math.min(
			first.maxDeliveriesPerConnection,
			second.maxDeliveriesPerConnection
		),
	};
}

export async function resolveDeliveryRoute(
	redis: Redis,
	config: MtaConfig,
	recipient: string,
	resolvedDestination: DestinationSnapshot | undefined
): Promise<RouteResolution> {
	const recipientDomain = extractDomain(recipient);
	const destination =
		resolvedDestination ?? (await resolveDestinationSnapshot(redis, recipientDomain, { config }));

	if (destination.mx.status === 'temporary-failure') {
		return {
			kind: 'undeliverable',
			result: {
				success: false,
				error: destination.mx.reason,
				bounceType: 'deferred',
				smtpCode: 451,
			},
		};
	}
	if (destination.mx.status === 'domain-not-found') {
		return {
			kind: 'undeliverable',
			result: {
				success: false,
				error: destination.mx.reason,
				bounceType: 'hard',
				smtpCode: 550,
			},
		};
	}
	if (destination.mx.status === 'null-mx') {
		return {
			kind: 'undeliverable',
			result: {
				success: false,
				error: `Recipient domain ${recipientDomain} explicitly does not accept email (Null MX)`,
				bounceType: 'hard',
				smtpCode: 556,
				enhancedCode: '5.1.10',
			},
		};
	}

	const mxHosts = destination.mx.hosts.map((host) => host.exchange);
	const routeProvider = providerFromMxHostnames(mxHosts);
	const snapshotProfile = await getProfile(redis, destination.providerKey);
	const routeProfile =
		routeProvider === destination.providerKey
			? snapshotProfile
			: await getProfile(redis, routeProvider);

	return {
		kind: 'route',
		route: {
			recipientDomain,
			mxHosts,
			routeProvider,
			providerPolicy: strictestDeliveryProviderPolicy(snapshotProfile, routeProfile),
			daneDestinations: new Map(
				(destination.daneDestinations ?? []).map((daneDestination) => [
					daneDestination.mxHostname,
					daneDestination,
				])
			),
			daneDiscoveryAuthenticated: destination.daneDiscoveryAuthenticated,
		},
	};
}
