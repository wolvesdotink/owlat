/**
 * KIND LITERALS OUTSIDE THE ADAPTER FOLDERS ARE AN ENUMERATED, SHRINKING SET.
 *
 * Seams plan D2: no code outside an adapter folder may declare a provider kind
 * as a literal (`= 'ses'`); D3 sanctions exactly one exception (own vs.
 * not-own) and says every other "is this our own MTA?" test READS its
 * declaration. What the leak sweep could not convert is the map below, asserted
 * in both directions: a declaration in a file not on it fails, an entry whose
 * file no longer declares one fails and must be deleted.
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

/**
 * Every remaining declaration, with the FAMILY it belongs to and who clears it.
 * None of these is definitional; they are capability gaps with named owners.
 */
const SURVIVING_KIND_LITERALS: Record<string, { family: string; owner: string }> = {
	'delivery/checklistValidatorTypes.ts': {
		family: 'frozen-sibling-read',
		owner:
			'P1.2 — replaced by asking the loaded rows which kind they belong to, once the ' +
			'generic sendingDomainRelayIdentities read lands',
	},
};

// Files whose own-arm comparison is the sanctioned D3 exception.
const OWN_ARM_COMPARISON_EXEMPT = new Set(['domains/lifecycle.ts', 'delivery/lastMileRouting.ts']);

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

const unexplained = declarationOffenders.filter((file) => !(file.path in SURVIVING_KIND_LITERALS));
check(
	unexplained.length === 0,
	'these files declare a provider kind as a literal — ask the catalog (lib/sendProviders/catalog.ts) or, for own-vs-not-own, read OWN_ARM_TRANSPORT_KIND / OWN_SENDING_DOMAIN_PROVIDER_KIND; adding an entry to SURVIVING_KIND_LITERALS is a plan change, not a fix:\n  ' +
		unexplained.map((file) => `${file.path} (${file.kinds.join(', ')})`).join('\n  ')
);

const withLiterals = new Set(declarationOffenders.map((file) => file.path));
const stale = Object.keys(SURVIVING_KIND_LITERALS).filter((path) => !withLiterals.has(path));
check(
	stale.length === 0,
	`these SURVIVING_KIND_LITERALS entries no longer have a declaration — delete them: ${stale.join(', ')}`
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

for (const [path, entry] of Object.entries(SURVIVING_KIND_LITERALS)) {
	check(/^[a-z-]+$/.test(entry.family), `${path} has no family`);
	check(entry.owner.length > 10, `${path} has no owner`);
	check(entry.family === 'frozen-sibling-read', `${path} names an unknown family ${entry.family}`);
}

report(
	'check-kind-literal-custody',
	`${Object.keys(SURVIVING_KIND_LITERALS).length} surviving declaration(s)`
);
