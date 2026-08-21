import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { columnIndex, section, tableHeader, tableRows } from './markdownDocs';

/**
 * The trust-registry page makes claims an operator acts on — privacy floors, a
 * default that decides whether a public log hears about their users' mail, and
 * which tier is allowed to move a message. None of those numbers lives on the
 * page; they live in `ostr-observer`, `ostr-registry` and `deliverToMailbox`,
 * and a page that keeps quoting a floor after somebody lowered it is worse than
 * a page that never quoted one.
 *
 * So every number and env-var name below is read out of source and compared,
 * both locales together: lowering `minRecipients` from 5 to 2, or dropping the
 * `flagged` branch in a delivery refactor, fails here rather than silently
 * leaving two pages promising the old guarantee.
 *
 * The page carried two NOT-YET-WIRED callouts until the MTA client, the Convex
 * observer and the reader's chip landed. Those pins are now inverted: they fail
 * if the callouts come back, and they fail if the wiring they describe goes
 * away, so the pages cannot drift in either direction.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const enPage = readRepoFile('apps/docs/content/en/3.developer/24.trust-registry.md');
const dePage = readRepoFile('apps/docs/content/de/3.developer/24.trust-registry.md');

const thresholdsSource = readRepoFile('packages/ostr-observer/src/thresholds.ts');
const eligibilitySource = readRepoFile('packages/ostr-observer/src/eligibility.ts');
const distributionSource = readRepoFile('packages/ostr-core/src/distribution.ts');
const registryConfig = readRepoFile('apps/ostr-registry/src/config.ts');
const registryApp = readRepoFile('apps/ostr-registry/src/http/app.ts');
const deliverySource = readRepoFile('apps/api/convex/mail/delivery.ts');
const signalsSource = readRepoFile('apps/api/convex/ostr/signals.ts');
const convexEnvSource = readRepoFile('apps/api/convex/lib/env.ts');
const convexOstrConfig = readRepoFile('apps/api/convex/ostr/config.ts');
const windowSource = readRepoFile('apps/api/convex/ostr/window.ts');
// `config.ts` plus the OSTR module it delegates the `OSTR_*` parsing to — one
// env-reading surface, split across two files by the file-size gate.
const mtaConfigSource = [
	readRepoFile('apps/mta/src/config.ts'),
	readRepoFile('apps/mta/src/ostrConfig.ts'),
].join('\n');
const threadReaderSource = readRepoFile('apps/web/app/components/postbox/PostboxThreadReader.vue');
const featureFlagsSource = readRepoFile('packages/shared/src/featureFlags.ts');
const compose = readRepoFile('docker-compose.yml');

/** The `{ … }` body of an exported object literal, by declaration name. */
function objectLiteral(source: string, declaration: string): string {
	const start = source.indexOf(declaration);
	expect(start, `${declaration} not found`).toBeGreaterThan(-1);
	const open = source.indexOf('{', start);
	const close = source.indexOf('\n};', open);
	expect(close, `${declaration} is not a closed object literal`).toBeGreaterThan(open);
	return source.slice(open, close);
}

/** `key: 123` inside an object literal body. */
function numericField(body: string, key: string): number {
	const hit = new RegExp(`\\b${key}:\\s*([0-9_]+)`).exec(body);
	expect(hit, `no numeric field "${key}"`).not.toBeNull();
	return Number(hit![1]!.replaceAll('_', ''));
}

const K_THRESHOLDS = objectLiteral(thresholdsSource, 'DEFAULT_K_THRESHOLDS');
const K_FLOORS: Record<string, number> = Object.fromEntries(
	['minMessages', 'minRecipients', 'minReports', 'minReporters', 'minTrapHits'].map((key) => [
		key,
		numericField(K_THRESHOLDS, key),
	])
);

const MIN_MAILBOXES = Number(
	/OBSERVER_MIN_MAILBOXES\s*=\s*(\d+)/.exec(eligibilitySource)?.[1] ?? NaN
);

const TIERS = (/const TIERS: readonly Tier\[\] = \[([^\]]+)\]/.exec(distributionSource)?.[1] ?? '')
	.split(',')
	.map((entry) => entry.trim().replaceAll("'", ''))
	.filter(Boolean);

const REGISTRY_PORT = Number(/'OSTR_REGISTRY_PORT',\s*(\d+)/.exec(registryConfig)?.[1] ?? NaN);
const DEFAULT_ZONE_ORIGIN = /DEFAULT_ZONE_ORIGIN\s*=\s*'([^']+)'/.exec(registryConfig)?.[1] ?? '';

/** The two locale pages, so every claim is asserted in both or in neither. */
const pages = [
	{ locale: 'en', page: enPage },
	{ locale: 'de', page: dePage },
] as const;

/** The thresholds table, keyed by its `` `minX` `` code span. */
function documentedFloors(page: string, heading: string): Record<string, string> {
	const body = section(page, heading);
	const header = tableHeader(body);
	const defaultAt = columnIndex(header, header[1]!);
	const out: Record<string, string> = {};
	for (const row of tableRows(body)) {
		const name = /`([a-zA-Z]+)`/.exec(row[0]!)?.[1];
		if (name) out[name] = row[defaultAt]!;
	}
	return out;
}

describe('trust registry docs — k-anonymity floors', () => {
	it('reads five floors out of ostr-observer, so the table has something to disagree with', () => {
		expect(Object.values(K_FLOORS).every(Number.isInteger)).toBe(true);
		expect(K_FLOORS['minRecipients']).toBeGreaterThan(1);
	});

	it.each(pages)('$locale documents every shipped floor, number for number', ({ locale, page }) => {
		const heading =
			locale === 'en' ? '### The k-anonymity hold-back' : '### Zurückhalten bis zur k-Anonymität';
		const documented = documentedFloors(page, heading);
		expect(Object.keys(documented).sort()).toEqual(Object.keys(K_FLOORS).sort());
		for (const [key, value] of Object.entries(K_FLOORS)) {
			expect(documented[key], `${locale}: ${key}`).toBe(String(value));
		}
	});

	it('states the raise-only clamp both pages promise', () => {
		// `resolveKThresholds` clamps an override UP to the default unless the
		// caller types `unsafeAllowBelowDefaultFloors`. A page that described the
		// override as free-form would invite exactly the configuration the clamp
		// exists to refuse.
		expect(thresholdsSource).toContain('Math.max(value, fallback)');
		expect(thresholdsSource).toContain('unsafeAllowBelowDefaultFloors');
		expect(enPage).toMatch(/may raise any of these and only raise them/i);
		expect(enPage).toMatch(/clamped back up/i);
		expect(dePage).toMatch(/anheben und ausschließlich anheben/i);
		expect(dePage).toMatch(/geklemmt/i);
	});
});

describe('trust registry docs — the observer mailbox floor', () => {
	it('quotes the packaged floor from ostr-observer in both locales', () => {
		expect(MIN_MAILBOXES).toBeGreaterThan(1);
		expect(enPage).toMatch(new RegExp(`packaged floor of ${MIN_MAILBOXES} mailboxes`));
		expect(dePage).toMatch(new RegExp(`Untergrenze von ${MIN_MAILBOXES} Postfächern`));
		// The floor is a refusal, not advice. Both pages say so, because an
		// operator who reads "warning" configures around it.
		expect(eligibilitySource).toContain("reason: 'below-mailbox-threshold'");
		expect(enPage).toMatch(/refusal rather than a warning/i);
		expect(dePage).toMatch(/Verweigerung und keine Warnung/i);
	});

	it('says OSTR_MIN_MAILBOXES can only raise the floor, which is what the code does', () => {
		expect(eligibilitySource).toContain('Math.max(requested, OBSERVER_MIN_MAILBOXES)');
		expect(enPage).toMatch(/It can only raise it\./);
		expect(dePage).toMatch(/Anheben ist die einzige mögliche Richtung\./);
	});
});

describe('trust registry docs — the five tiers', () => {
	it('lists exactly the shipped tiers, in the shipped order, in both locales', () => {
		expect(TIERS).toEqual(['unknown', 'establishing', 'trusted', 'warned', 'flagged']);
		for (const tier of TIERS) expect(signalsSource).toContain(`v.literal('${tier}')`);
		for (const { locale, page } of pages) {
			const heading =
				locale === 'en' ? '## What a lookup answers' : '## Was eine Abfrage beantwortet';
			const listed = tableRows(section(page, heading)).map(
				(row) => /`([a-z]+)`/.exec(row[0]!)?.[1]
			);
			expect(listed, locale).toEqual(TIERS);
		}
	});
});

describe('trust registry docs — what a tier is allowed to do', () => {
	it('files only a flagged sender to spam, and only under the ostr flag', () => {
		// The one routing consequence in the product. Both halves are pinned: the
		// tier test (`flagged` alone) and the flag test — drop either and the
		// pages' central promise ("a signal rather than a verdict") is false.
		expect(signalsSource).toMatch(/isOstrFlaggedTier[\s\S]{0,300}tier === 'flagged'/);
		const clause = deliverySource.slice(deliverySource.indexOf('const ostrRoutesToSpam'));
		expect(clause.slice(0, 400)).toContain('isOstrFlaggedTier(args.ostrTier)');
		expect(clause.slice(0, 400)).toContain("resolveFlagsFromSettings(settings)['ostr'] === true");
		expect(clause).toMatch(/ostrRoutesToSpam\s*\n?\s*\?\s*'spam'/);
		// No other tier is compared against anywhere on the delivery path.
		for (const tier of TIERS.filter((name) => name !== 'flagged')) {
			expect(deliverySource, `delivery.ts must not branch on '${tier}'`).not.toContain(`'${tier}'`);
		}
		expect(enPage).toMatch(/the only tier that changes where mail lands is `flagged`/i);
		expect(dePage).toMatch(/die den Ablageort verändert, ist `flagged`/i);
	});

	it('records the tier whether or not the flag is on, in source and on both pages', () => {
		// `ostrTier` is a plain optional column on the delivery mutation, not
		// something the flag guards — which is what makes the flag a reversible
		// step you can inspect first. Both pages sell it that way.
		expect(deliverySource).toContain('ostrTier: v.optional(ostrTierValidator)');
		expect(enPage).toMatch(/stored on every delivered message whether the flag is on or off/i);
		expect(dePage).toMatch(/gespeichert, ob das Flag an ist oder aus/i);
	});

	it('names the ostr flag with the gate and the plane the registry declares', () => {
		// Sliced to the ENTRY, not to the end of FEATURE_FLAGS: a registry-wide
		// search would find `requires: ['postbox']` on some neighbouring flag and
		// pass while the ostr entry had lost it.
		const start = featureFlagsSource.indexOf('\tostr: {');
		expect(start, 'no `ostr` entry in FEATURE_FLAGS').toBeGreaterThan(-1);
		const flag = featureFlagsSource.slice(start, featureFlagsSource.indexOf('\n\t},', start));
		expect(flag).toContain('default: false');
		expect(flag).toContain("requires: ['postbox']");
		expect(flag).toContain(
			"requiredEnvVars: ['OSTR_AGGREGATOR_URL', 'OSTR_AGGREGATOR_PUBLIC_KEY']"
		);
		expect(enPage).toContain("requires: ['postbox']");
		expect(dePage).toContain("requires: ['postbox']");
	});
});

describe('trust registry docs — the off state and the wiring behind it', () => {
	it('documents OSTR_ENABLED as defaulting to false, which is what compose passes', () => {
		expect(compose).toContain('OSTR_ENABLED: ${OSTR_ENABLED:-false}');
		for (const { locale, page } of pages) {
			const heading = locale === 'en' ? '## Consuming the registry' : '## Die Registry nutzen';
			const body = section(page, heading);
			const header = tableHeader(body);
			const purposeAt = columnIndex(header, header[2]!);
			const row = tableRows(body).find((cells) => cells[0] === '`OSTR_ENABLED`');
			expect(row, `${locale}: no OSTR_ENABLED row`).toBeDefined();
			expect(row![purposeAt]).toMatch(/`false`/);
		}
	});

	it('passes every OSTR variable apps/mta reads through to the container', () => {
		// The MTA client has landed, so the NOT-YET-WIRED callout is gone and the
		// pin runs the other way: a variable `config.ts` reads and compose never
		// passes is a knob both pages document and no container ever sees.
		const read = new Set([...mtaConfigSource.matchAll(/'(OSTR_[A-Z_]+)'/g)].map((hit) => hit[1]!));
		expect(read.size, 'apps/mta reads no OSTR variable').toBeGreaterThan(0);
		for (const key of read) {
			expect(compose, `compose must pass ${key} to the mta service`).toContain(`${key}: \${${key}`);
		}
		for (const { locale, page } of pages) {
			expect(page, locale).not.toMatch(/does not read any `OSTR_\*` variable/i);
			expect(page, locale).not.toMatch(/liest in diesem Release keine `OSTR_\*`-Variable/i);
		}
	});

	it('has every documented Convex variable in the runtime allowlist', () => {
		// Convex functions cannot read a variable that is not an `EnvKey`, so a
		// page documenting one that is missing sends an operator to a
		// `convex env set` that silently does nothing.
		for (const key of [
			'OSTR_AGGREGATOR_URL',
			'OSTR_AGGREGATOR_PUBLIC_KEY',
			'OSTR_OBSERVER_ENABLED',
			'OSTR_OBSERVER_DOMAIN',
			'OSTR_OBSERVER_PRIVATE_KEY',
			'OSTR_LOG_URLS',
			'OSTR_MIN_MAILBOXES',
		]) {
			expect(convexEnvSource, `${key} must be an EnvKey`).toContain(`| '${key}'`);
			expect(enPage).toContain(`\`${key}\``);
			expect(dePage).toContain(`\`${key}\``);
		}
		for (const { locale, page } of pages) {
			expect(page, locale).not.toMatch(/not yet wired/i);
			expect(page, locale).not.toMatch(/noch nicht verdrahtet/i);
		}
	});

	it('says the observer switch has to be set on both sides, because it is read twice', () => {
		// `OSTR_OBSERVER_ENABLED` lives in two processes: the MTA captures the
		// DKIM evidence, Convex signs and submits it. A page documenting only the
		// Convex half sends an operator to an observer that sees no evidence.
		expect(mtaConfigSource).toContain("optionalEnv('OSTR_OBSERVER_ENABLED', 'false')");
		expect(convexOstrConfig).toContain("getBoolean('OSTR_OBSERVER_ENABLED')");
		expect(compose).toContain('OSTR_OBSERVER_ENABLED: ${OSTR_OBSERVER_ENABLED:-false}');
		expect(enPage).toMatch(/has to be set twice/i);
		expect(dePage).toMatch(/zweimal gesetzt werden muss/i);
	});

	it('claims the tier chip only because apps/web reads the tier under the flag', () => {
		const webReaders = sourceFilesUnder('apps/web/app').filter(
			(file) => !file.includes('__tests__') && readFileSync(file, 'utf8').includes('ostrTier')
		);
		expect(
			webReaders.length,
			'apps/web reads no ostrTier — the pages must not claim a chip'
		).toBeGreaterThan(0);
		expect(threadReaderSource).toContain("isFeatureEnabled('ostr')");
		expect(threadReaderSource).toContain(':ostr-tier="msg.ostrTier"');
		expect(enPage).toMatch(/gates the routing decision and the tier chip/i);
		expect(dePage).toMatch(/Ablageentscheidung und den Stufen-Chip/);
		for (const { locale, page } of pages) {
			expect(page, locale).not.toMatch(/Nothing in `apps\/web` reads it yet/);
			expect(page, locale).not.toMatch(/Nichts in `apps\/web` liest sie bislang/);
		}
	});
});

describe('trust registry docs — what v1 leaves out', () => {
	it('names the three publishing deferrals the observer window documents in code', () => {
		// `window.ts` explains these to the next maintainer; nothing explained
		// them to the operator until this section existed. Both have to agree.
		expect(windowSource).toContain('Trap hits');
		expect(windowSource).toContain('IP subjects are absent');
		expect(windowSource).toMatch(/SERVING a challenge[\s\S]{0,80}is also not here/);
		expect(enPage).toContain('### What v1 leaves out');
		expect(dePage).toContain('### Was v1 auslässt');
		for (const claim of [/No trap hits/, /No IP subjects/, /No challenge endpoint/]) {
			expect(enPage, String(claim)).toMatch(claim);
		}
		for (const claim of [
			/Keine Trap-Treffer/,
			/Keine IP-Subjekte/,
			/Kein Endpunkt für Stichproben/,
		]) {
			expect(dePage, String(claim)).toMatch(claim);
		}
	});

	it('publishes no trap-hit batch, which is what the pages promise', () => {
		// `buildTrapHitBatch` is exported by `@owlat/ostr-observer` and
		// deliberately never called. Calling it is the moment the note is false.
		expect(windowSource).not.toContain('buildTrapHitBatch(');
	});
});

describe('trust registry docs — running a node', () => {
	it('quotes the registry port, placeholder zone and health path from the node', () => {
		expect(REGISTRY_PORT).toBe(3300);
		expect(DEFAULT_ZONE_ORIGIN).toBe('ostr.invalid');
		expect(registryApp).toContain("app.get('/healthz'");
		for (const { locale, page } of pages) {
			expect(page, locale).toContain(`ostr-registry:${REGISTRY_PORT}`);
			expect(page, locale).toContain(`\`${DEFAULT_ZONE_ORIGIN}\``);
			expect(page, locale).toContain('`/healthz`');
		}
	});

	it('states the STH-interval refusal the node actually enforces', () => {
		expect(registryConfig).toContain('if (sthIntervalSeconds > mmdSeconds) {');
		expect(enPage).toMatch(/`OSTR_STH_INTERVAL_SECONDS` may not exceed `OSTR_MMD_SECONDS`/);
		expect(dePage).toMatch(
			/`OSTR_STH_INTERVAL_SECONDS` darf `OSTR_MMD_SECONDS` nicht überschreiten/
		);
	});

	it('names only registry variables the node config reads', () => {
		// Every `OSTR_*` span in the node section has to be a key `config.ts`
		// resolves, or the page is documenting a knob that does nothing.
		const named = new Set(
			[
				...between(
					enPage,
					'## Running your own registry node',
					'## Specification and decisions'
				).matchAll(/`(OSTR_[A-Z_]+)`/g),
			].map((hit) => hit[1]!)
		);
		expect(named.size).toBeGreaterThan(3);
		for (const key of named) expect(registryConfig, key).toContain(`'${key}'`);
	});
});

/**
 * The text between two headings.
 *
 * NOT `section()` from `./markdownDocs`: that helper stops at the first line
 * starting with `#`, and this page fences an `.ini` snippet whose first line is
 * the comment `# .env — …`. The shared parser therefore ends the node section
 * a third of the way in, and a "no undocumented knobs" assertion built on it
 * would pass by never seeing the knobs.
 */
function between(page: string, from: string, to: string): string {
	const start = page.indexOf(`${from}\n`);
	const end = page.indexOf(`${to}\n`);
	expect(start, `no section "${from}"`).toBeGreaterThan(-1);
	expect(end, `no section "${to}" after "${from}"`).toBeGreaterThan(start);
	return page.slice(start, end);
}

/** Every `.ts`/`.vue` file under a repo-relative directory. */
function sourceFilesUnder(relative: string): string[] {
	const root = resolve(repoRoot, relative);
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && ['.ts', '.vue'].includes(extname(entry.name)))
		.map((entry) => join(entry.parentPath, entry.name));
}
