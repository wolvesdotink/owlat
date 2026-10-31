/**
 * NO KIND LITERALS OUTSIDE THE ADAPTER FOLDERS.
 *
 * Capabilities, not identity: no code outside an adapter folder may declare a provider kind
 * as a literal (`= 'ses'`). Ask the catalog or the adapter's own declaration
 * instead; there is exactly one sanctioned exception (own vs. not-own), and
 * every "is this our own MTA?" test READS its declaration.
 *
 * Declarations only. The COMPARISON half is owned by `scripts/check-provider-
 * identity.sh` (root `lint:providers`) over a strict superset of these files.
 *
 * Run by `bun run lint` (apps/api): `bun scripts/check-kind-literal-custody.ts`.
 */
import { join } from 'node:path';
import { OWN_SEND_PROVIDER_KIND, SEND_TRANSPORT_KINDS } from '@owlat/shared';
import { createChecker, productionModules, sourceMap } from './lib/sourceGraph';

const convexRoot = join(import.meta.dirname, '..', 'convex');

const { check, report } = createChecker();

// The adapter folders own their kind; migrations and the two adapter
// registries (index.ts files the ratchet reads) write their own names.
// Codegen and tests never enter the walk (lib/sourceGraph.ts).
const EXEMPT_PREFIXES = [
	...SEND_TRANSPORT_KINDS.map((kind) => `lib/sendProviders/${kind}/`),
	'domains/providers/',
	'webhooks/adapters/',
	'migrations/',
];

// Files whose own-arm comparison is the sanctioned own-vs-not-own exception.
const OWN_ARM_COMPARISON_EXEMPT = new Set(['delivery/lastMileRouting.ts']);

// `= 'ses'` that is not part of `==`, `!=`, `<=`, `>=`.
const declarationPattern = (kind: string): RegExp => new RegExp(`(^|[^=!<>])=\\s*'${kind}'`, 'gm');

const scanned = [...sourceMap(convexRoot, productionModules(convexRoot))].map(([path, source]) => ({
	path,
	source,
}));
const inScope = scanned.filter(
	(file) => !EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix))
);

const declarationOffenders = inScope
	.map((file) => ({
		path: file.path,
		kinds: SEND_TRANSPORT_KINDS.filter((kind) => declarationPattern(kind).test(file.source)),
	}))
	.filter((file) => file.kinds.length > 0);

// ─── The checks ─────────────────────────────────────────────────────────────

const paths = scanned.map((file) => file.path);
check(paths.length > 200, `walked only ${paths.length} files`);
for (const landmark of ['delivery/sendLifecycle.ts', 'webhooks/dispatcher.ts']) {
	check(paths.includes(landmark), `${landmark} dropped out of the walk`);
}

check(
	declarationOffenders.length === 0,
	"these files declare a provider kind as a literal — ask the catalog (lib/sendProviders/catalog.ts) or the adapter module's own `kind`, or, for own-vs-not-own, read OWN_ARM_TRANSPORT_KIND / OWN_SENDING_DOMAIN_PROVIDER_KIND:\n  " +
		declarationOffenders.map((file) => `${file.path} (${file.kinds.join(', ')})`).join('\n  ')
);

const ownArm = new RegExp(
	`(===|!==|case)\\s*'${OWN_SEND_PROVIDER_KIND}'|'${OWN_SEND_PROVIDER_KIND}'\\s*(===|!==)`
);
const restated = inScope
	.filter((file) => ownArm.test(file.source))
	.map((file) => file.path)
	.filter((path) => !OWN_ARM_COMPARISON_EXEMPT.has(path));
check(
	restated.length === 0,
	`these files compare a kind to '${OWN_SEND_PROVIDER_KIND}' instead of reading OWN_ARM_TRANSPORT_KIND (send transports) or OWN_SENDING_DOMAIN_PROVIDER_KIND (domains.providerType): ${restated.join(', ')}`
);

for (const path of OWN_ARM_COMPARISON_EXEMPT) {
	check(
		inScope.some((file) => file.path === path && ownArm.test(file.source)),
		`${path} no longer compares a kind to '${OWN_SEND_PROVIDER_KIND}' — delete it from OWN_ARM_COMPARISON_EXEMPT`
	);
}

report('check-kind-literal-custody', `${inScope.length} file(s) scanned, no kind declarations`);
