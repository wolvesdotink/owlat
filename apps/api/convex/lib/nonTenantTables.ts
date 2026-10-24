import type { TableNames } from '../_generated/dataModel';

/**
 * Tables deliberately NOT wiped by the tenant-data paths, with the reason each
 * is excluded. Listed explicitly so the exhaustiveness guard in
 * `./tenantTables.ts` can prove the union of {tenant, non-tenant} covers the
 * whole schema.
 */
export const NON_TENANT_TABLES = [
	// Auth identity — deleted explicitly by the account-deletion / reset paths,
	// or owned by BetterAuth (user/account/organization/member live in the
	// betterAuth component schema, not here).
	'userProfiles',
	'onboardingProgress',
	// Per-user first-login checklist, keyed by authUserId like userProfiles.
	// Deleted with the departing user in the member-erasure path and cleared by
	// the dev reset step; never org-scoped, so not swept by the tenant walker.
	'userOnboarding',
	// "You can send now" onboarding nudges, keyed by authUserId like
	// `userOnboarding` and deleted with the departing member in the member-erasure
	// path. Holds no contact business data — a user id and two timestamps.
	'sendReadyNotices',
	// Last observed "can this instance send at all?" sample — deployment
	// infrastructure state (the edge detector behind those notices), recreated by
	// the next cron tick like the other regenerable telemetry singletons.
	'sendPathReadiness',
	'platformAdmins',
	// The deletion-tracking table itself — account deletion patches the request
	// row to `completed`, so it must survive the wipe.
	'accountDeletionRequests',
	// Member erasure's progress rows. The erasure they drive runs across a
	// workspace deletion (it waits for the sweep), so they must outlive it too.
	'memberErasureJobs',
	// Workspace deletion's own control plane (the durable job and the write
	// fence's switch). It has to outlive the tables it empties, and its finished
	// rows are the generation history.
	'workspaceDeletionJobs',
	'workspaceDeletionProgress',
	// The migration ledger and its runner's row: which data migrations ran here, how far
	// they got, who started the run. Deployment state, not org data: a contract step reads
	// it after any wipe, and a wipe must not make a finished migration look unstarted.
	'migrationRuns',
	'migrationDriver',
	// Instance configuration singleton — recreated by setup; reset clears it in a
	// dedicated step. The flag singleton and counter rows split off it go with
	// it, in the same reset step and the walker's terminal steps.
	'instanceSettings',
	'featureFlagSettings',
	'instanceCounters',
	// Progress of the instance-wide sweep that clears body-search excerpts when
	// the operator turns the switch off: a generation, counts and a pagination
	// cursor, no message content. It follows the instance switch rather than the
	// org, and a sweep still running during a wipe must keep its fence.
	'mailBodySearchPurges',
	// Sweep and sampler marks, no Send, contact or row content. The lost-send pass
	// leases go stale after a wipe and are taken over by the next pass.
	'lostSendSweepLeases',
	'derivedFieldCursors', // the derived-field drift sampler's place in each table
	// Instance infrastructure / regenerable caches — not org business data.
	'systemUpdates',
	// Worker release and wire-version reports; the next report regenerates them.
	'imapServers',
	'workerServers',
	// Cache of the desktop releases GitHub has published, refetched by a cron —
	// public release metadata and manifests, regenerable in one poll.
	'desktopReleases',
	'backupState',
	'urlReputationCache',
	'providerRoutes',
	'providerHealth',
	'warmingState',
	'mtaIpReadinessAlerts',
	// Deployment-scoped transport capability fact: does this send transport let us
	// set a custom VERP return path? Keyed by transport id with no organizationId,
	// no credentials and no contact business data — a re-probeable property of the
	// relay itself, shared by every org on the deployment. Like `providerHealth`,
	// it is regenerable telemetry about infrastructure, so it is out of the tenant
	// wipe (wiping it would only force a needless re-probe).
	'sendTransportReturnPathProbes',
	// Microsoft SNDS per-IP daily telemetry. Keyed by the deployment's SENDING
	// IPs, not by anything of this org's: bands, filter results and trap counts
	// Microsoft attributes to the infrastructure. Regenerable by re-polling the
	// feed, so it is out of the tenant wipe like `warmingState` / `tlsReports`.
	'sndsIpDailyStats',
	// Inbound TLS-RPT (RFC 8460) aggregate reports from partner MX — operator
	// deliverability telemetry keyed by the partner's own report-id, not org
	// business data. Regenerable (partners re-send daily); not personal data of
	// this org's contacts, so it is out of the tenant wipe like warmingState.
	'tlsReports',
	// End-to-end encryption key material (Sealed Mail): the instance signing
	// identity plus per-address OpenPGP keypairs whose PUBLIC halves are published
	// for discovery. Kept on purpose, unlike `aiProviderConfig`: nobody
	// entered these as credentials, the instance minted them, and other instances
	// have recorded and pinned their fingerprints. The identity row signs the
	// manifest whose rotation feed is the only way a pinned key may change; a
	// wiped address key re-minted for a re-created address reaches every peer that
	// pinned the old one as a key change with no signed rotation, which each of
	// them has to re-accept by hand.
	'keyVault',
	// Sealed Mail recipient-key discovery cache + TOFU trust ledger. Holds only
	// PUBLIC keys of OTHER instances' recipients plus their pin state — a
	// regenerable discovery cache (re-fetched from the peer's manifest/WKD), not
	// this org's contact business data, so it is out of the tenant wipe like
	// `keyVault` and the other caches.
	'recipientKeys',
	// Sealed Mail published key-rotation statements. Signed old->new
	// fingerprint bindings we serve in the manifest rotation feed. Public material
	// only, regenerable from the vault's rotation history — instance crypto
	// infrastructure, not this org's contact business data, so it is out of the
	// tenant wipe like `keyVault` / `recipientKeys`.
	'keyRotations',
	// Replay claims for the bundled-plugin feedback route. One row per
	// accepted delivery, holding a HASH of the caller's signature and nothing
	// else: no address, no message id, no payload. It is wire-protocol
	// bookkeeping about requests the deployment received, it self-expires within
	// the signature contract's tolerance (minutes), and wiping it early would only
	// re-open a replay window — so it is out of the tenant wipe like the other
	// protocol/telemetry tables.
	'pluginWebhookDeliveries',
	// "When did this bundled transport's feedback channel last deliver?" — one
	// timestamp per transport kind, stamped when a batch finishes dispatching, so
	// the Delivery page can grade a channel that does not retain raw payloads.
	// Operational health telemetry about the deployment's own inbound plumbing:
	// no address, no message id, no payload, and regenerable the moment the next
	// batch arrives. Out of the tenant wipe like `providerHealth` and the other
	// protocol/telemetry tables — wiping it would only make a working channel
	// read as `awaiting_event` until the provider next spoke.
	'pluginWebhookFeedbackActivity',
	// Replay claims for single provider events (Mandrill): the adapter's
	// address-free `replayKey` (event name, provider message id, timestamp) and
	// the claim state, nothing else. Wire-protocol bookkeeping like
	// `pluginWebhookDeliveries`, self-expiring a week after the event; wiping
	// it early would only re-open a replay window.
	'inboundEventClaims',
] as const satisfies readonly TableNames[];
