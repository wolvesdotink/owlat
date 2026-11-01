/**
 * The relay identities a provider route's deliverability fallback depends on:
 * the read the relay domain status panel renders, and the catch-up drain
 * `providerRoutes.ts`'s `setRoute` schedules when a fallback is switched on.
 *
 * Each builder's body is an exported helper, so the previous release's paths
 * (`providerRoutes.ts` at the convex root) run the same code.
 */
import { v, type ObjectType } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { type MutationCtx, type QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import {
	requirePermission,
	hasPermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { SEND_PROVIDER_CATALOG } from '../lib/sendProviders/catalog';
import {
	enabledFallbackRelayKinds,
	ensureRelayIdentities,
	relayIdentityBackfills,
} from '../lib/sendProviders/fallbackRelays';
import {
	describeSharedRelayIdentity,
	OWN_SENDING_DOMAIN_PROVIDER_KIND,
	relayIdentityProviders,
} from '../domains/providers';
import { logError } from '../lib/runtimeLog';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';

/**
 * The relay kinds this organization has configured as a deliverability escape
 * hatch — ENABLED OR NOT.
 *
 * Publishing a relay's DNS is what an operator does BEFORE switching the hatch
 * on, so filtering on `isEnabled` would hide the records from exactly the
 * operator who is mid-setup. It is computed here, not in
 * `RelayDomainStatus.vue` over a second `listRoutes` subscription, because it
 * decides which kinds the read below reports "provisioning" for, and a
 * visibility rule computed in the browser cannot be more truthful than the rows
 * it filters.
 */
async function configuredRelayKinds(ctx: QueryCtx): Promise<ReadonlySet<string>> {
	const routes = await ctx.db.query('providerRoutes').collect(); // bounded: one row per message type
	return new Set(
		routes.flatMap((route) =>
			route.deliverabilityFallback ? [route.deliverabilityFallback.relayProviderType] : []
		)
	);
}

/** The operator's name for a kind, from the composed catalog — never a literal. */
function relayKindLabel(kind: string): string {
	return SEND_PROVIDER_CATALOG.find((entry) => entry.kind === kind)?.label ?? kind;
}

/**
 * Every relay identity this deployment holds for its owned sending domains —
 * one row per (domain, relay kind), for WHICHEVER KINDS THE REGISTRY PROVES.
 *
 * NOT SES-SHAPED, AND NOT ONE QUERY PER VENDOR. A query that point-reads the
 * frozen `sendingDomainSesIdentities` sibling and shapes its result around SES's
 * bundle (dkim tokens, MAIL FROM, `spfProofState`) makes one vendor's storage the
 * shape of the surface: Mandrill's identities then need a second, `providerKind
 * === 'mandrill'` query under a second Vue panel, and the bundled plugin relay
 * tier — which writes the same generic table Mandrill does — writes rows NO
 * surface can render, so a deployment relaying through a plugin transport is
 * told, forever, that provisioning is queued.
 *
 * SO THE ANSWERING KINDS COME FROM THE REGISTRY (`relayIdentityProviders()`),
 * not from this file. Each kind describes its own domain through
 * `describeRelayIdentity`, or through the generic read of the shared row when it
 * implements no such arm, and this handler only adds the two facts a PROVIDER
 * cannot know: that the domain's own verification has not landed yet
 * (`awaiting_primary_verification`), and that a relay this deployment has
 * CONFIGURED holds no identity for it yet (`provisioning`). Registering a kind
 * therefore extends the answer; nothing here is edited for the sixth relay.
 *
 * A DOMAIN CAN APPEAR MORE THAN ONCE, which is why the row carries `kind` and
 * `kindLabel` rather than the page being keyed by domain: two relays configured
 * at once is a real (if discouraged) state, and the surface has to be able to say
 * which one is waiting on what. Pagination is still over `domains` — the cursor
 * has to walk one table — so a page may hold more rows than domains, or none at
 * all when this deployment has configured no relay and holds no identities.
 *
 * Admin-gated (`organization:manage`): which third party a domain is registered
 * with, and why it has not verified, is operational configuration.
 */
export const listRelayDomainIdentitiesArgs = { paginationOpts: paginationOptsValidator };

export async function listRelayIdentityRows(
	ctx: QueryCtx,
	args: ObjectType<typeof listRelayDomainIdentitiesArgs>,
	session: MutationSessionContext
) {
	requirePermission(hasPermission(session.role, 'organization:manage'));
	const page = await ctx.db
		.query('domains')
		.withIndex('by_provider_type', (q) => q.eq('providerType', OWN_SENDING_DOMAIN_PROVIDER_KIND))
		.paginate(args.paginationOpts);
	const configured = await configuredRelayKinds(ctx);
	const rows = await Promise.all(
		page.page.map(async (domain) => {
			const described = await Promise.all(
				relayIdentityProviders().map(async (provider) => ({
					kind: provider.kind,
					facts: provider.describeRelayIdentity
						? await provider.describeRelayIdentity(ctx, domain)
						: await describeSharedRelayIdentity(ctx, provider.kind, domain.domain),
				}))
			);
			return described.flatMap(({ kind, facts }) => {
				// A kind with no identity and no configured route has nothing to
				// say about this domain — reporting `provisioning` for it would
				// invent a run that will never start, which is the shipped bug one
				// kind over.
				if (!facts && !configured.has(kind)) return [];
				return [
					{
						domainId: domain._id,
						domain: domain.domain,
						kind,
						kindLabel: relayKindLabel(kind),
						status:
							domain.status !== 'verified'
								? ('awaiting_primary_verification' as const)
								: (facts?.status ?? ('provisioning' as const)),
						records: facts?.records ?? [],
						spf: facts?.spf,
						dkim: facts?.dkim,
						lastError: facts?.lastError,
						lastCheckedAt: facts?.lastCheckedAt,
						nextCheckDueAt: facts?.nextCheckDueAt,
						proofMaxAgeMs: facts?.proofMaxAgeMs,
						isOwnershipVerified: facts?.isOwnershipVerified,
						spfProof: facts?.spfProof,
					},
				];
			});
		})
	);
	return { ...page, page: rows.flat() };
}

// authz: listRelayIdentityRows requires organization:manage before it reads.
export const listRelayDomainIdentities = authedQuery({
	args: listRelayDomainIdentitiesArgs,
	handler: async (ctx, args, session) => await listRelayIdentityRows(ctx, args, session),
});

/**
 * Cursor drain used when fallback is enabled; future domains use lifecycle
 * provisioning.
 *
 * WHICH relay is a PARAMETER, not a literal. This mutation used to
 * name `sendingDomainSesIdentities` and `domains.sesRelay.provision` directly,
 * which was correct only for as long as SES was the one relay a route could
 * name. Since the fallback gate became a capability question, `resend`, `smtp`
 * and `mandrill` routes save too — and every one of them would have had SES
 * identities provisioned across the whole domain table, calling an API the
 * deployment may hold no credentials for and publishing DNS guidance for a
 * provider the operator never chose. The kind now travels from the route that
 * named it and the backfill is asked of THAT kind's sending-domain provider.
 *
 * A relay with nothing to register at (`domainVerification: 'none'`, so no
 * `ensureRelayIdentity` — Resend, a bring-your-own SMTP relay) stops the drain
 * before it reads a page: there is no identity to backfill, which is the same
 * honest posture `relayDomainVerification.ts` takes on the read side.
 *
 * `relayProviderType` IS OPTIONAL, and absent is a definite answer rather than
 * a no-op. Convex persists a scheduled function's arguments, so a continuation
 * this mutation scheduled for itself BEFORE the argument existed would fail
 * argument validation the moment the deploy lands — and the shipped gate
 * already admits `ses`, `resend`, `smtp` and `mandrill` fallbacks, so that
 * abandoned drain could belong to any of them. It would stop at its cursor and
 * every domain past it would keep no relay identity (the lifecycle's forward
 * path only covers domains verified LATER), which the operator only ever sees
 * as a refusal to relay, and only once the breaker opens. So absent means
 * "whichever relays the routes currently name" — resolved from the same
 * `providerRoutes` read the forward path uses, per page, so an operator who
 * changes the relay mid-drain gets the new one.
 */
export const provisionDeliverabilityRelayBatchArgs = {
	relayProviderType: v.optional(v.string()),
	paginationOpts: paginationOptsValidator,
};

export async function provisionRelayBatch(
	ctx: MutationCtx,
	args: ObjectType<typeof provisionDeliverabilityRelayBatchArgs>
) {
	const kinds =
		args.relayProviderType === undefined
			? await enabledFallbackRelayKinds(ctx)
			: [args.relayProviderType];
	// Resolved once per BATCH, not once per domain: an empty result means the
	// configured relay has nothing to register at, and the drain then stops
	// before it reads a page rather than paginating the whole domain table to
	// call nothing. The registry filter itself lives with the rule, in
	// `lib/sendProviders/fallbackRelays.ts` — the forward half of this pair
	// (`domains/lifecycleEffects.ts`'s `provision_relay_identity_if_enabled` effect)
	// calls the same two functions, so neither half can grow a private idea of
	// which relay a domain's identity is for or of which domains get one.
	const backfills = relayIdentityBackfills(kinds);
	if (backfills.length === 0) return;
	const page = await ctx.db
		.query('domains')
		.withIndex('by_status', (q) => q.eq('status', 'verified'))
		.paginate(args.paginationOpts);
	// ONE SUMMARY PER PAGE, because the per-domain throw is swallowed so it
	// cannot roll the page back. Without it a page in which every domain's
	// backfill threw — a transient org lookup, a provider row that vanished —
	// commits as a success, schedules its successor and reports the drain
	// complete having provisioned nothing, and the only later symptom is the
	// relay refusing those From domains once the breaker opens.
	//
	// COUNTED, NOT ESTIMATED. The numbers are the domains that actually failed
	// and the per-kind tally, never the page size: a page holds every verified
	// domain, most of which the own-MTA gate skips without attempting anything,
	// so reporting `page.page.length` would tell an operator chasing a relay
	// refusal that a 99%-successful page failed wholesale.
	//
	// `reprovision: false` — the drain converges. It re-runs whenever an
	// operator touches the fallback and walks every verified domain each time,
	// so a domain that already holds an identity is done; re-registering it
	// would re-issue a provider call per domain per page. The forward path is
	// the half that repairs (`reprovision: true`); see
	// `EnsureRelayIdentityOptions`.
	const failedByKind = new Map<string, number>();
	let failedDomains = 0;
	for (const domain of page.page) {
		const outcome = await ensureRelayIdentities(ctx, domain, backfills, { reprovision: false });
		if (outcome.failedKinds.length > 0) failedDomains += 1;
		for (const kind of outcome.failedKinds) {
			failedByKind.set(kind, (failedByKind.get(kind) ?? 0) + 1);
		}
	}
	if (failedByKind.size > 0) {
		logError(
			`[Relay identity] Drain page left ${failedDomains} domain(s) unprovisioned: ` +
				[...failedByKind].map(([kind, count]) => `${kind}=${count}`).join(', ')
		);
	}
	if (!page.isDone) {
		await ctx.scheduler.runAfter(
			500,
			internal.delivery.providerRouteRelays.provisionDeliverabilityRelayBatch,
			{
				relayProviderType: args.relayProviderType,
				paginationOpts: { cursor: page.continueCursor, numItems: args.paginationOpts.numItems },
			}
		);
	}
}

export const provisionDeliverabilityRelayBatch = internalMutation({
	args: provisionDeliverabilityRelayBatchArgs,
	handler: async (ctx, args) => await provisionRelayBatch(ctx, args),
});
