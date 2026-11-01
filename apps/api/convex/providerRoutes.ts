/**
 * Previous-release paths of `delivery/providerRoutes.ts` and
 * `delivery/providerRouteRelays.ts`. The provider routing, delivery migration
 * and relay domain status surfaces in a tab opened before the deploy call
 * `providerRoutes:*` by path, and a relay identity drain page the previous
 * release queued runs as `providerRoutes:provisionDeliverabilityRelayBatch`.
 * Each keeps its old path, builder, auth floor, arguments and result shape, and
 * runs the same body as its replacement. Remove after release 0.6.17.
 */
import { internalMutation } from './lib/writeFence';
import { authedMutation, authedQuery } from './lib/authedFunctions';
import {
	deleteRoute,
	listMtaIpPools,
	listProviderRoutes,
	removeRouteArgs,
	saveRoute,
	setRouteArgs,
	transportCatalog,
} from './delivery/providerRoutes';
import {
	listRelayDomainIdentitiesArgs,
	listRelayIdentityRows,
	provisionDeliverabilityRelayBatchArgs,
	provisionRelayBatch,
} from './delivery/providerRouteRelays';

/** Remove after release 0.6.17; this release calls `delivery/providerRoutes:listRoutes`. */
// authz: listProviderRoutes requires organization:manage before it reads.
export const listRoutes = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => await listProviderRoutes(ctx, session),
});

/** Remove after release 0.6.17; this release calls `delivery/providerRoutes:listIpPools`. */
// all-members: a static, non-sensitive capability list (two fixed pool names,
// no org data, no credentials), the same posture as the new path.
export const listIpPools = authedQuery({
	args: {},
	handler: async () => listMtaIpPools(),
});

/** Remove after release 0.6.17; this release calls `delivery/providerRoutes:listTransportCatalog`. */
// all-members: transport labels and readiness booleans are the same non-secret
// delivery state every member may already read from the routing/status surfaces.
export const listTransportCatalog = authedQuery({
	args: {},
	handler: async (ctx) => await transportCatalog(ctx),
});

/** Remove after release 0.6.17; this release calls `delivery/providerRouteRelays:listRelayDomainIdentities`. */
// authz: listRelayIdentityRows requires organization:manage before it reads.
export const listRelayDomainIdentities = authedQuery({
	args: listRelayDomainIdentitiesArgs,
	handler: async (ctx, args, session) => await listRelayIdentityRows(ctx, args, session),
});

/**
 * Remove after release 0.6.17; this release schedules
 * `delivery/providerRouteRelays:provisionDeliverabilityRelayBatch`. A page the
 * previous release queued drains here and schedules its successor at the new
 * path.
 */
export const provisionDeliverabilityRelayBatch = internalMutation({
	args: provisionDeliverabilityRelayBatchArgs,
	handler: async (ctx, args) => await provisionRelayBatch(ctx, args),
});

/** Remove after release 0.6.17; this release calls `delivery/providerRoutes:setRoute`. */
// authz: saveRoute requires organization:manage before it writes.
export const setRoute = authedMutation({
	args: setRouteArgs,
	handler: async (ctx, args, session) => await saveRoute(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `delivery/providerRoutes:removeRoute`. */
// authz: deleteRoute requires organization:manage before it writes.
export const removeRoute = authedMutation({
	args: removeRouteArgs,
	handler: async (ctx, args, session) => await deleteRoute(ctx, args, session),
});
