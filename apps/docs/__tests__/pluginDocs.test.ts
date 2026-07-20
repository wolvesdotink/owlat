import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Docs-lint for the plugin-platform chapter (PP-30).
 *
 * The chapter documents contracts that live in code, so every claim here is
 * pinned to the source that implements it:
 *
 *   1. every fenced TypeScript sample is the VERBATIM text of a region in
 *      `packages/plugin-kit/src/__tests__/docsSamples.test.ts`, which compiles
 *      under that package's `tsc --noEmit` and is exercised by its own
 *      assertions — and, in the inverse direction, no ```ts fence is anything
 *      other than such a region, so no sample can drift into pseudocode
 *      (declarative shape sketches are tagged ```text, not ```ts);
 *   2. every identifier the chapter imports from `@owlat/plugin-kit` is a real
 *      export of `packages/plugin-kit/src/index.ts`;
 *   3. the capability, limit, and vocabulary tables match the constants the
 *      host actually enforces;
 *   4. every page is reachable from the docs sidebar.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function read(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const CONTENT_DIR = 'apps/docs/content/3.developer';

const PAGES = {
	overview: '40.plugin-platform.md',
	authoring: '41.plugin-authoring.md',
	contributions: '42.plugin-contributions.md',
	capabilities: '43.plugin-capabilities.md',
	operations: '44.plugin-operations.md',
	cli: '45.plugin-cli.md',
	connectedApps: '46.plugin-connected-apps.md',
	sandboxedJobs: '47.plugin-sandboxed-jobs.md',
	troubleshooting: '48.plugin-troubleshooting.md',
} as const;

const docs = Object.fromEntries(
	Object.entries(PAGES).map(([key, file]) => [key, read(`${CONTENT_DIR}/${file}`)])
) as Record<keyof typeof PAGES, string>;

const chapter = Object.values(docs).join('\n');

const samplesSource = read('packages/plugin-kit/src/__tests__/docsSamples.test.ts');
const kitIndex = read('packages/plugin-kit/src/index.ts');

/** Which page must quote which executable sample region. */
const REGION_MAP: ReadonlyArray<{ region: string; page: keyof typeof PAGES }> = [
	{ region: 'minimal-manifest', page: 'overview' },
	{ region: 'minimal-manifest', page: 'authoring' },
	{ region: 'contribution-manifest', page: 'authoring' },
	{ region: 'gate-module', page: 'authoring' },
	{ region: 'cron-module', page: 'authoring' },
	{ region: 'send-transport-module', page: 'contributions' },
	{ region: 'agent-step-module', page: 'contributions' },
	{ region: 'automation-step-module', page: 'contributions' },
	{ region: 'import-provider-module', page: 'contributions' },
];

function regionSource(name: string): string {
	const start = samplesSource.indexOf(`// #region ${name}\n`);
	const end = samplesSource.indexOf(`// #endregion ${name}`);
	if (start === -1 || end === -1) throw new Error(`docsSamples has no region "${name}"`);
	return samplesSource.slice(start + `// #region ${name}\n`.length, end).trimEnd();
}

/**
 * The body of one markdown section, from its heading up to the next heading of
 * the same or a higher level. Lets an assertion pin what a specific section
 * says instead of accepting the word appearing anywhere on the page.
 */
function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(`${heading}\n`);
	if (start === -1) throw new Error(`no section "${heading}"`);
	const level = heading.indexOf(' ');
	const rest = markdown.slice(start + heading.length);
	const next = rest.search(new RegExp(`\\n#{1,${level}} `));
	return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Every `.ts`/`.vue` source under a directory, so an assertion can derive the
 * real caller set of a seam instead of trusting a hand-maintained list.
 */
function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue;
		if (entry.isDirectory()) files.push(...sourceFiles(`${dir}/${entry.name}`));
		else if (/\.(ts|vue)$/.test(entry.name)) files.push(`${dir}/${entry.name}`);
	}
	return files;
}

/** The contribution buckets the manifest type declares, in declaration order. */
function contributionKinds(): string[] {
	const contributions = read('packages/plugin-kit/src/contributions.ts');
	return [
		...contributions
			.slice(
				contributions.indexOf('PLUGIN_CONTRIBUTION_KINDS = ['),
				contributions.indexOf('] as const;')
			)
			.matchAll(/'([a-zA-Z]+)'/g),
	].map((match) => match[1]!);
}

/**
 * Every capability string the kit defines, derived from its sources instead of
 * listed here: capabilities are `namespace:verb` string literals and nothing
 * else in `packages/plugin-kit/src/*.ts` has that shape, so a capability added
 * by a later piece joins this set on its own and must be documented.
 */
function kitCapabilities(): Set<string> {
	const capabilities = new Set<string>();
	for (const entry of readdirSync(resolve(repoRoot, 'packages/plugin-kit/src'), {
		withFileTypes: true,
	})) {
		if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
		for (const match of read(`packages/plugin-kit/src/${entry.name}`).matchAll(
			/'([a-z][a-z-]*:[a-z][a-z-]*)'/g
		)) {
			capabilities.add(match[1]!);
		}
	}
	return capabilities;
}

/** The capability named by each row of the contribution reference's bucket table. */
function documentedBucketCapabilities(): Set<string> {
	const summary = section(docs.contributions, '## Bucket summary');
	return new Set([...summary.matchAll(/^\| `\w+` \| `([^`]+)` \|/gm)].map((match) => match[1]!));
}

/** Number words the prose may use for a small count. */
const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

/**
 * Where each host-mediated (bucket-less) capability's limits are actually
 * stated: the page, the route the contribution reference must link to, and a
 * marker unique to that page's limit table.
 */
const LIMIT_PAGES: Readonly<
	Record<string, { page: keyof typeof PAGES; route: string; marker: RegExp }>
> = {
	'llm:invoke': {
		page: 'capabilities',
		route: '/developer/plugin-capabilities',
		marker: /### LLM budgets/,
	},
	'plugin-storage:read': {
		page: 'capabilities',
		route: '/developer/plugin-capabilities',
		marker: /### Storage isolation and limits/,
	},
	'plugin-storage:write': {
		page: 'capabilities',
		route: '/developer/plugin-capabilities',
		marker: /### Storage isolation and limits/,
	},
	'worker:enqueue': {
		page: 'sandboxedJobs',
		route: '/developer/plugin-sandboxed-jobs',
		marker: /100 `queued` \+ `running`/,
	},
};

/** Every fenced ```ts block on a page. */
function typescriptFences(markdown: string): string[] {
	return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd());
}

describe('plugin docs: samples are the executable source, verbatim', () => {
	for (const { region, page } of REGION_MAP) {
		it(`${PAGES[page]} quotes the "${region}" sample exactly`, () => {
			const source = regionSource(region);
			expect(source.length).toBeGreaterThan(0);
			// Equality, not containment: a fence that merely CONTAINS its region can
			// carry hand-written lines that nothing compiles or runs.
			expect(
				typescriptFences(docs[page]),
				`no \`\`\`ts fence in ${PAGES[page]} is the "${region}" region verbatim`
			).toContain(source);
		});
	}

	it('has no ```ts fence that is not a quoted sample region', () => {
		// The inverse of the assertions above: a hand-written sketch tagged `ts`
		// would be compiled and asserted by nothing, which is exactly the
		// pseudocode drift this suite exists to prevent. Shape sketches that are
		// not compilable TypeScript are tagged ```text instead.
		const sources = REGION_MAP.map((entry) => regionSource(entry.region));
		for (const [key, file] of Object.entries(PAGES)) {
			for (const fence of typescriptFences(docs[key as keyof typeof PAGES])) {
				expect(
					sources,
					`a \`\`\`ts fence in ${file} is not a sample region verbatim:\n${fence}`
				).toContain(fence);
			}
		}
	});

	it('covers every region defined in the executable sample file', () => {
		// The capture must match `regionSource`'s marker format, which accepts any
		// name: a narrower class would silently skip a region such as `sample-2`
		// and the completeness guarantee would lapse without a failure.
		const declared = [...samplesSource.matchAll(/\/\/ #region ([\w-]+)\n/g)].map((m) => m[1]!);
		const quoted = new Set(REGION_MAP.map((entry) => entry.region));
		expect(declared.length).toBeGreaterThan(0);
		for (const region of declared) {
			expect(quoted.has(region), `region "${region}" is never quoted by a doc page`).toBe(true);
		}
	});
});

describe('plugin docs: imported identifiers exist in @owlat/plugin-kit', () => {
	/** Names the chapter claims are importable from the public package. */
	const imported = new Set<string>();
	for (const match of chapter.matchAll(
		/import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+'@owlat\/plugin-kit';/g
	)) {
		for (const raw of match[1]!.split(',')) {
			const name = raw
				.trim()
				.split(/\s+as\s+/)[0]!
				.trim();
			if (name) imported.add(name);
		}
	}

	it('the chapter imports a non-trivial set of public names', () => {
		expect(imported.size).toBeGreaterThan(10);
	});

	for (const name of [...imported].sort()) {
		it(`exports ${name}`, () => {
			expect(kitIndex).toMatch(new RegExp(`(^|[\\s,{])${name}([\\s,}]|$)`, 'm'));
		});
	}
});

describe('plugin docs: capability vocabulary matches the shipped constants', () => {
	const capabilities = [...kitCapabilities()].sort();

	it('derives the capability vocabulary from the kit sources', () => {
		// A guard on the derivation itself: if the literal shape ever changes and
		// the scan returns nothing, the per-capability cases below would all
		// vanish silently instead of failing.
		expect(capabilities.length).toBeGreaterThan(12);
	});

	for (const capability of capabilities) {
		it(`documents ${capability} on both the capability and contribution pages`, () => {
			expect(docs.capabilities).toContain(`\`${capability}\``);
			expect(docs.contributions).toContain(`\`${capability}\``);
		});
	}

	it('names a real capability in every bucket row', () => {
		const bucketCapabilities = documentedBucketCapabilities();
		expect(bucketCapabilities.size).toBeGreaterThan(10);
		for (const capability of bucketCapabilities) {
			expect(capabilities, `bucket row names unknown capability ${capability}`).toContain(
				capability
			);
		}
	});

	it('names every capability that has no contribution bucket', () => {
		// The sentence that closes the vocabulary-to-bucket mapping. Everything the
		// bucket table does not claim is host-mediated and must be named there, so
		// a reader diffing the two lists is left with no unexplained leftovers.
		const bucketCapabilities = documentedBucketCapabilities();
		const unmapped = capabilities.filter((capability) => !bucketCapabilities.has(capability));
		expect(unmapped.length).toBeGreaterThan(0);

		const summary = section(docs.contributions, '## Bucket summary');
		const sentence = summary.split('\n').find((line) => line.includes('no contribution bucket'));
		expect(sentence, 'the bucket summary must say which capabilities have no bucket').toBeTypeOf(
			'string'
		);
		for (const capability of unmapped) {
			expect(sentence!, `${capability} has no bucket and is not named`).toContain(
				`\`${capability}\``
			);
		}
		for (const capability of bucketCapabilities) {
			expect(sentence!, `${capability} has a bucket and must not be named`).not.toContain(
				`\`${capability}\``
			);
		}
		expect(sentence!).toContain(`${COUNT_WORDS[unmapped.length]} capabilities have no`);

		// A bucket-less capability is documented by that sentence alone, so the
		// pointer it carries must lead to the page that actually states the
		// capability's limits — not merely to the capability reference. Each
		// marker is the limit table itself, and it must live on exactly one page:
		// if a table moves, the uniqueness check retires the stale route instead
		// of letting the link rot.
		for (const capability of unmapped) {
			const target = LIMIT_PAGES[capability];
			expect(target, `${capability} has no bucket and no documented limit page`).toBeTypeOf(
				'object'
			);
			const { page, route, marker } = target!;
			expect(docs[page], `${capability} limits are no longer on ${route}`).toMatch(marker);
			for (const [key, body] of Object.entries(docs)) {
				if (key === page) continue;
				expect(
					body,
					`${capability} limits also appear on ${key}; the route is ambiguous`
				).not.toMatch(marker);
			}
			expect(sentence!, `${capability} limits are on ${route}, which the sentence omits`).toContain(
				route
			);
		}
	});

	it('documents every contribution bucket the manifest type declares', () => {
		const kinds = contributionKinds();
		expect(kinds.length).toBeGreaterThan(15);
		for (const kind of kinds) {
			expect(docs.contributions, `bucket ${kind} is undocumented`).toContain(`\`${kind}\``);
		}
	});

	it('counts the core agent steps and their placements correctly', () => {
		const agentSteps = read('packages/plugin-host/src/agentSteps.ts');
		const definitions = agentSteps.slice(
			agentSteps.indexOf('CORE_AGENT_STEP_DEFINITIONS = Object.freeze(['),
			agentSteps.indexOf('export type CoreAgentStepKind')
		);
		// `route` is terminal: it carries `placement: undefined` and so is not a
		// legal anchor, which is why the anchor table lists one fewer step.
		const entries = [...definitions.matchAll(/Object\.freeze\(\{([\s\S]*?)\}\)/g)].map(
			(match) => match[1]!
		);
		const steps = entries.map((entry) => /kind: '([a-z_]+)'/.exec(entry)![1]!);
		const anchors = entries
			.filter((entry) => !entry.includes('placement: undefined'))
			.map((entry) => /kind: '([a-z_]+)'/.exec(entry)![1]!);
		expect(steps).toEqual([
			'security_scan',
			'context_retrieval',
			'classify',
			'clarify',
			'draft',
			'route',
		]);
		expect(definitions).toMatch(
			/kind: 'route', continuationStatus: undefined, placement: undefined/
		);
		expect(anchors).toEqual(steps.filter((kind) => kind !== 'route'));

		const placements = [
			...agentSteps
				.slice(
					agentSteps.indexOf('SAFE_LIFECYCLE_EDGES_BY_PLACEMENT'),
					agentSteps.indexOf('/** Flatten manifest declarations')
				)
				.matchAll(/^\t([a-z_]+): Object\.freeze\(/gm),
		].map((match) => match[1]!);
		expect(placements).toEqual(['classification', 'before_draft', 'after_draft']);

		const stepSection = section(docs.contributions, '## Agent steps');
		const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
		expect(stepSection).toContain(
			`${NUMBER_WORDS[anchors.length]!.replace(/^./, (c) => c.toUpperCase())} of the ${
				NUMBER_WORDS[steps.length]
			} built-in steps`
		);
		expect(stepSection).toContain(`${NUMBER_WORDS[placements.length]} host-owned placements`);
		expect(stepSection).toMatch(/terminal `route` step[^.]*no placement/);
		for (const anchor of anchors) {
			expect(stepSection, `anchor ${anchor} is not listed`).toContain(`\`${anchor}\``);
		}
		for (const placement of placements) {
			expect(stepSection, `placement ${placement} is not listed`).toContain(`\`${placement}\``);
		}
	});

	it('documents every API scope the backend recognises', () => {
		const scopes = read('apps/api/convex/auth/apiScopes.ts');
		const declared = [
			...scopes
				.slice(scopes.indexOf('ENDPOINT_SCOPES = ['), scopes.indexOf('export const API_SCOPES'))
				.matchAll(/'([a-z-]+:[a-z-]+)'/g),
		].map((match) => match[1]!);
		expect(declared.length).toBeGreaterThan(5);
		for (const scope of declared) {
			expect(docs.capabilities, `scope ${scope} is undocumented`).toContain(`\`${scope}\``);
		}
	});
});

/**
 * The one shape every limits case below uses: derive the declared names from the
 * source, require the documented set to be exactly that set (so an added,
 * removed, or renamed bound fails until the page says so), then pin each
 * literal to where it is declared and each rendered phrase to the section that
 * renders it (so a retuned bound fails until the page is retuned with it).
 *
 * Written once rather than per case: each copy of the loop was another place a
 * future author could weaken one call site by accident.
 */
function expectDocumentedLimits(options: {
	/** Sources one of which must contain each literal, as written in code. */
	sources: readonly string[];
	/** Text the declared names are read from. Defaults to all of `sources`. */
	declaration?: string;
	/** Must capture the declared name in group 1, and must be global. */
	declaredPattern: RegExp;
	/** Names deliberately left undocumented, excluded by name, never silently. */
	exclude?: ReadonlySet<string>;
	/** How the literal is written: `NAME = value;` or `field: value,`. */
	form?: 'const' | 'field';
	/** The rendered failure clause, so table cases read as table cases. */
	proseFailure?: 'is undocumented' | 'has no table row';
	/** Body of the one section that must render every phrase. */
	section: string;
	rendered: Readonly<Record<string, { literal: string; prose: string }>>;
}): void {
	const { sources, declaredPattern, form = 'const', proseFailure = 'is undocumented' } = options;
	const declaration = options.declaration ?? sources.join('\n');
	const declared = [...declaration.matchAll(declaredPattern)]
		.map((match) => match[1]!)
		.filter((name) => !options.exclude?.has(name));
	expect(new Set(declared)).toEqual(new Set(Object.keys(options.rendered)));

	for (const [name, { literal, prose }] of Object.entries(options.rendered)) {
		const written = form === 'const' ? `${name} = ${literal};` : `${name}: ${literal},`;
		expect(
			sources.some((source) => source.includes(written)),
			`${name} is no longer ${literal}`
		).toBe(true);
		expect(options.section, `${name} (${prose}) ${proseFailure}`).toContain(prose);
	}
}

describe('plugin docs: limits match the constants the host enforces', () => {
	it('documents the cron scheduling and timeout envelope', () => {
		// Both ends of both ranges, derived from the declaration rather than
		// chosen: a renamed, added, or retuned bound fails until the table says so.
		expectDocumentedLimits({
			sources: [read('packages/plugin-kit/src/cron.ts')],
			declaredPattern: /^export const (PLUGIN_CRON_\w+) = ([\d_ *]+);/gm,
			section: section(docs.contributions, '## Crons'),
			rendered: {
				PLUGIN_CRON_MIN_INTERVAL_MINUTES: {
					literal: '15',
					prose: '| `schedule.intervalMinutes` | 15 …',
				},
				PLUGIN_CRON_MAX_INTERVAL_MINUTES: {
					literal: '28 * 24 * 60',
					prose: '… 40 320 (four weeks) |',
				},
				PLUGIN_CRON_TIMEOUT_MIN_MS: { literal: '1_000', prose: '| `timeoutMs` | 1 000 …' },
				PLUGIN_CRON_TIMEOUT_MAX_MS: {
					literal: '5 * 60_000',
					prose: '… 300 000 (five minutes) |',
				},
			},
		});
	});

	it('documents the Tier-3 worker envelope', () => {
		// Same treatment, and the two 64 KiB rows are pinned separately: the
		// payload ceiling rejects at enqueue while the result ceiling truncates,
		// so a bare `toContain('64 KiB')` would let either row cover the other.
		expectDocumentedLimits({
			sources: [read('packages/plugin-kit/src/workerTask.ts')],
			declaredPattern: /^export const (PLUGIN_WORKER_\w+) = ([\d_ *]+);/gm,
			section: section(docs.sandboxedJobs, '## Enqueue limits'),
			rendered: {
				PLUGIN_WORKER_MIN_ATTEMPTS: { literal: '1', prose: '| Attempts | clamped to 1 …' },
				PLUGIN_WORKER_MAX_ATTEMPTS: { literal: '5', prose: '… 5 |' },
				PLUGIN_WORKER_TIMEOUT_MIN_MS: {
					literal: '1_000',
					prose: '| Single-execution wall clock | clamped to 1 s …',
				},
				PLUGIN_WORKER_TIMEOUT_MAX_MS: { literal: '15 * 60_000', prose: '… 15 min |' },
				PLUGIN_WORKER_PAYLOAD_MAX_BYTES: {
					literal: '64 * 1024',
					prose: '| Payload | ≤ 64 KiB (oversized ⇒ rejected at enqueue) |',
				},
				PLUGIN_WORKER_RESULT_MAX_BYTES: {
					literal: '64 * 1024',
					prose: '| Stored result | ≤ 64 KiB (oversized ⇒ truncated before persisting) |',
				},
				PLUGIN_WORKER_MAX_PENDING_JOBS: {
					literal: '100',
					prose: '| In-flight jobs per (organization, plugin) | 100 `queued` + `running` |',
				},
			},
		});
	});

	it('documents the Tier-3 container ceilings the compose file sets', () => {
		// The security page states these as fact, and an operator sizes a host
		// and reviews the uid boundary against them, so they are pinned to the
		// compose service and the image that create them — not just to prose.
		const compose = read('docker-compose.yml');
		const start = compose.indexOf('\n  code-worker:\n');
		expect(start, 'the code-worker service moved').not.toBe(-1);
		const service = compose.slice(
			start + 1,
			start + 1 + compose.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
		);
		const sandbox = section(docs.sandboxedJobs, '## The sandbox');

		for (const [setting, row] of [
			[
				'mem_limit: ${CODE_WORKER_MEM_LIMIT:-2g}',
				'| `mem_limit` | 2 g (`CODE_WORKER_MEM_LIMIT`) |',
			],
			['cpus: ${CODE_WORKER_CPUS:-1.0}', '| `cpus` | 1.0 (`CODE_WORKER_CPUS`) |'],
			[
				'pids_limit: ${CODE_WORKER_PIDS_LIMIT:-512}',
				'| `pids_limit` | 512 (`CODE_WORKER_PIDS_LIMIT`) |',
			],
			[
				'- /tmp:size=256m',
				'| Filesystem | `read_only: true`, writes confined to the `code-workspace` volume and a 256 MiB `/tmp` tmpfs |',
			],
			['read_only: true', '`read_only: true`'],
			['- no-new-privileges:true', '`no-new-privileges: true`'],
			['- code-worker', 'The isolated `code-worker` bridge, shared only with Convex'],
		] as const) {
			expect(service, `the compose service no longer sets ${setting}`).toContain(setting);
			expect(sandbox, `${setting} (${row}) is undocumented`).toContain(row);
		}

		// The capability row is built from the granted list rather than matched
		// against a copy of it, so adding a fourth capability fails the row.
		expect(service).toContain('cap_drop:\n      - ALL\n');
		const capabilities = [
			...service.slice(service.indexOf('cap_add:')).matchAll(/^ {6}- ([A-Z][A-Z_]*)$/gm),
		].map((match) => match[1]!);
		expect(capabilities.length).toBeGreaterThan(0);
		expect(
			sandbox,
			`the granted capabilities ${capabilities.join(', ')} are undocumented`
		).toContain(
			`| Capabilities | \`cap_drop: ALL\`, then only ${capabilities
				.map((capability) => `\`${capability}\``)
				.join(', ')} |`
		);

		// The cross-uid boundary itself: the image creates the account the
		// orchestrator drops to, and the page names that uid.
		const dockerfile = read('apps/code-worker/Dockerfile');
		expect(dockerfile, 'the sandbox group is no longer gid 10001').toContain(
			'addgroup -S -g 10001 sandbox'
		);
		expect(dockerfile, 'the sandbox account is no longer uid 10001').toContain(
			'-G sandbox -u 10001 -s /sbin/nologin sandbox'
		);
		expect(sandbox, 'the sandbox uid/gid is undocumented').toContain('`sandbox` uid/gid (10001)');
	});

	it('documents every plugin-storage quota', () => {
		// Every field of the frozen limit object, not a chosen few: the map below
		// must cover the declaration exactly, so a new ceiling fails until it is
		// documented, and deleting the table row that renders one fails too.
		const storage = read('apps/api/convex/plugins/storageJson.ts');
		const declaration = storage.slice(
			storage.indexOf('PLUGIN_STORAGE_LIMITS = Object.freeze({'),
			storage.indexOf('});')
		);
		expectDocumentedLimits({
			sources: [declaration],
			declaredPattern: /^\t(\w+):/gm,
			form: 'field',
			proseFailure: 'has no table row',
			section: section(docs.capabilities, '### Storage isolation and limits'),
			rendered: {
				maxKeyBytes: { literal: '256', prose: '| 256 bytes |' },
				maxValueBytes: { literal: '64 * 1024', prose: '| 64 KiB |' },
				maxEntries: { literal: '1_000', prose: '| 1 000 |' },
				maxTotalBytes: { literal: '10 * 1024 * 1024', prose: '| 10 MiB |' },
				maxListPageSize: { literal: '100', prose: '| 100 |' },
				maxJsonDepth: { literal: '32', prose: '| 32 / 4 096 / 1 024 / 1 024 |' },
				maxJsonNodes: { literal: '4_096', prose: '| 32 / 4 096 / 1 024 / 1 024 |' },
				maxArrayItems: { literal: '1_024', prose: '| 32 / 4 096 / 1 024 / 1 024 |' },
				maxObjectFields: { literal: '1_024', prose: '| 32 / 4 096 / 1 024 / 1 024 |' },
			},
		});
	});

	it('documents every plugin LLM request bound', () => {
		expectDocumentedLimits({
			sources: [read('apps/api/convex/plugins/llmRequest.ts')],
			declaredPattern: /export const (PLUGIN_LLM_MAX_\w+) = /g,
			section: section(docs.capabilities, '### LLM budgets'),
			rendered: {
				PLUGIN_LLM_MAX_INPUT_BYTES: { literal: '64 * 1024', prose: '64 KiB of UTF-8 input' },
				PLUGIN_LLM_MAX_MESSAGE_BYTES: { literal: '32 * 1024', prose: '32 KiB each' },
				PLUGIN_LLM_MAX_MESSAGES: { literal: '32', prose: '32 messages' },
				PLUGIN_LLM_MAX_OUTPUT_TOKENS: { literal: '2048', prose: '2 048 output tokens' },
			},
		});
	});

	it('documents the Tier-2 hook envelope', () => {
		// The numbers an integrator implements against, pinned to their rows on
		// both pages: a bare `toContain('5 s')` was satisfied by an unrelated
		// `45 s` elsewhere on the page and pinned no threshold at all.
		const constants = read('apps/api/convex/lib/constants.ts');
		const declaredPattern =
			/^export const (CONNECTED_APP_HOOK_(?:TIMEOUT_MS|RESPONSE_TOLERANCE_MS|CIRCUIT_FAILURE_THRESHOLD|CIRCUIT_COOLDOWN_MS)) = /gm;
		const breaker =
			'| Circuit breaker | 5 consecutive failures per (app, kind) opens it; a 60 s cooldown then allows one half-open trial |';
		expectDocumentedLimits({
			sources: [constants],
			declaredPattern,
			proseFailure: 'has no table row',
			section: section(docs.connectedApps, '### What Owlat enforces on every call'),
			rendered: {
				CONNECTED_APP_HOOK_TIMEOUT_MS: {
					literal: '5_000',
					prose: '| Deadline | 5 s, then the fetch is aborted |',
				},
				CONNECTED_APP_HOOK_RESPONSE_TOLERANCE_MS: {
					literal: '30_000',
					prose: '| Response freshness | 30 s tolerance |',
				},
				CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD: { literal: '5', prose: breaker },
				CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS: { literal: '60_000', prose: breaker },
			},
		});

		// The troubleshooting page restates all four; pinning it too means the
		// two pages cannot drift apart from each other or from the constants.
		expectDocumentedLimits({
			sources: [constants],
			declaredPattern,
			section: section(docs.troubleshooting, '## Tier-2 hook failures'),
			rendered: {
				CONNECTED_APP_HOOK_TIMEOUT_MS: {
					literal: '5_000',
					prose: 'The endpoint took longer than 5 s',
				},
				CONNECTED_APP_HOOK_RESPONSE_TOLERANCE_MS: {
					literal: '30_000',
					prose: 'outside the 30 s tolerance',
				},
				CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD: {
					literal: '5',
					prose: 'Five consecutive failures tripped the breaker',
				},
				CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS: {
					literal: '60_000',
					prose: 'it retries one trial call after 60 s',
				},
			},
		});
	});

	it('documents the exact hook header names', () => {
		const protocol = read('apps/api/convex/connectedApps/hookProtocol.ts');
		for (const header of [
			'x-owlat-hook',
			'x-owlat-hook-version',
			'x-owlat-hook-app',
			'x-owlat-hook-timestamp',
			'x-owlat-hook-nonce',
			'x-owlat-hook-signature',
		]) {
			expect(protocol).toContain(`'${header}'`);
			expect(docs.connectedApps).toContain(header);
		}
	});

	it('documents the exact hook signing strings and header formats', () => {
		// The wire contract a third-party app implements HMAC verification
		// against. The field ORDER is itself a security property — the direction
		// tag is what stops a request signature being replayed as a response
		// signature, and the echoed request nonce is the response-replay defense
		// — so the sketch on the page is DERIVED from the two signing functions
		// rather than compared against a hand-copied list of them.
		const signature = read('apps/api/convex/connectedApps/hookSignature.ts');
		const protocol = read('apps/api/convex/connectedApps/hookProtocol.ts');
		const wire = section(docs.connectedApps, '### Wire contract');

		const version = /CONNECTED_APP_HOOK_PROTOCOL_VERSION = '(\w+)' as const;/.exec(protocol)?.[1];
		expect(version, 'hookProtocol.ts no longer declares a protocol version').toBeTruthy();

		/** The ordered signing fields of one builder, written as the page writes them. */
		function signingFields(direction: 'Request' | 'Response'): string[] {
			const start = signature.indexOf(`async function build${direction}SigningString`);
			expect(start, `hookSignature.ts has no build${direction}SigningString`).toBeGreaterThan(-1);
			const body = signature.slice(start, signature.indexOf(`].join('\\n');`, start));
			return [
				...body.matchAll(
					/`owlat\.hook\.(\w+)\.\$\{(\w+)\}`|await (\w+)\(fields\.(\w+)\)|String\(fields\.(\w+)\)|fields\.(\w+)/g
				),
			].map((match) => {
				const [, tag, tagVersion, digest, digestArgument, stringified, plain] = match;
				if (tag !== undefined) {
					expect(tagVersion, 'the domain tag no longer interpolates the protocol version').toBe(
						'CONNECTED_APP_HOOK_PROTOCOL_VERSION'
					);
					return `owlat.hook.${tag}.${version}`;
				}
				if (digest !== undefined) return `<${digest}(${digestArgument})>`;
				return `<${stringified ?? plain}>`;
			});
		}

		const expected = {
			request: signingFields('Request'),
			response: signingFields('Response'),
		};
		expect(expected.request.length, 'the request signing string derived as empty').toBeGreaterThan(
			4
		);
		expect(expected.response.length).toBe(expected.request.length);

		// The two columns of the ```text sketch, read positionally: each content
		// line carries the request field then the response field.
		const sketch = /```text\n([\s\S]*?)```/.exec(wire)?.[1];
		expect(sketch, 'the wire contract no longer renders a signing-string sketch').toBeTruthy();
		const documented: Record<'request' | 'response', string[]> = { request: [], response: [] };
		for (const line of sketch!.split('\n')) {
			const tokens = [...line.matchAll(/owlat\.hook\.\w+\.\w+|<[^>]+>/g)].map((match) => match[0]);
			if (tokens.length === 0) continue;
			expect(tokens.length, `the sketch line "${line.trim()}" is not two columns`).toBe(2);
			documented.request.push(tokens[0]!);
			documented.response.push(tokens[1]!);
		}

		for (const direction of ['request', 'response'] as const) {
			expect(
				documented[direction],
				`the ${direction} signing string is ${expected[direction].join(', ')}, but the page renders ${documented[direction].join(', ')}`
			).toEqual(expected[direction]);
		}

		// The header formats the signing string is transported in. Each is pinned
		// to the code that produces it, so a v2 bump moves the version row, both
		// domain tags and the signature scheme together.
		expect(signature, 'the signature scheme is no longer the protocol version').toContain(
			'const SIGNATURE_SCHEME = CONNECTED_APP_HOOK_PROTOCOL_VERSION;'
		);
		expect(signature, 'the signature header value is no longer `<scheme>=<mac>`').toContain(
			'return `${SIGNATURE_SCHEME}=${mac}`;'
		);
		expect(signature, 'hmacHex no longer returns hex').toContain('return bytesToHex(signature);');
		for (const row of [
			`Protocol version \`${version}\`.`,
			`| \`x-owlat-hook-version\` | \`${version}\` |`,
			`| \`x-owlat-hook-signature\` | \`${version}=<hex hmac>\` |`,
		]) {
			expect(
				wire,
				`CONNECTED_APP_HOOK_PROTOCOL_VERSION (${version}) is undocumented: ${row}`
			).toContain(row);
		}

		// The nonce entropy and the timestamp unit, derived from their sources.
		const nonceBytes = Number(/^const NONCE_ENTROPY_BYTES = (\d+);/m.exec(signature)?.[1]);
		expect(nonceBytes, 'hookSignature.ts no longer declares NONCE_ENTROPY_BYTES').toBeGreaterThan(
			0
		);
		expect(wire, `NONCE_ENTROPY_BYTES (${nonceBytes} bytes) is undocumented`).toContain(
			`| \`x-owlat-hook-nonce\` | Per-request ${nonceBytes * 8}-bit base64url nonce, signed |`
		);
		expect(
			read('apps/api/convex/connectedApps/hookClient.ts'),
			'the signed timestamp is no longer Unix seconds'
		).toContain('const timestampSeconds = Math.floor(nowMs / 1000);');
		expect(wire, 'the timestamp unit is undocumented').toContain(
			'| `x-owlat-hook-timestamp` | Unix **seconds**, signed |'
		);
	});

	it('documents every hook fallback reason the log can record', () => {
		const log = read('apps/api/convex/connectedApps/hookDeliveryLog.ts');
		// Slice the reason validator itself rather than denylisting the hook-kind
		// and delivery-source literals that share the file: a new kind or source
		// must not be misread as an undocumented fallback reason.
		const declaration = log.slice(
			log.indexOf('export const hookUnavailableCodeValidator = v.union('),
			log.indexOf('/** The literal union the validator accepts. */')
		);
		expect(declaration.length).toBeGreaterThan(0);
		const reasons = [...declaration.matchAll(/v\.literal\('([a-z_]+)'\)/g)].map(
			(match) => match[1]!
		);
		expect(reasons.length).toBeGreaterThan(15);
		for (const reason of reasons) {
			expect(
				docs.troubleshooting + docs.connectedApps,
				`reason ${reason} is undocumented`
			).toContain(`\`${reason}\``);
		}
	});

	it('documents every host error code and codegen error code', () => {
		const hostCodes = [
			...read('packages/plugin-host/src/errors.ts').matchAll(/\| '([a-z_]+)'/g),
		].map((match) => match[1]!);
		expect(hostCodes.length).toBeGreaterThan(8);
		for (const code of hostCodes) {
			expect(docs.troubleshooting, `host code ${code} is undocumented`).toContain(`\`${code}\``);
		}

		const codegenCodes = [
			...read('packages/plugin-codegen/src/errors.ts').matchAll(/\| '([a-z_]+)'/g),
		].map((match) => match[1]!);
		expect(codegenCodes.length).toBeGreaterThan(10);
		for (const code of codegenCodes) {
			expect(docs.troubleshooting, `codegen code ${code} is undocumented`).toContain(`\`${code}\``);
		}
	});

	it('documents the whole send-transport failure vocabulary', () => {
		const transport = read('packages/plugin-kit/src/sendTransport.ts');
		const codes = [
			...transport
				.slice(transport.indexOf('PLUGIN_SEND_FAILURE_CODES = ['), transport.indexOf('] as const;'))
				.matchAll(/'([a-z_]+)'/g),
		].map((match) => match[1]!);
		expect(codes.length).toBeGreaterThan(5);
		const transports = section(docs.contributions, '## Send transports');
		for (const code of codes) {
			expect(transports, `failure code ${code} is undocumented`).toContain(`\`${code}\``);
		}
	});

	it('documents the send-transport retry ceiling', () => {
		// The sketch on the page is ```text, not an executable sample, so nothing
		// else pins its "≤ 3": without this the shape could promise seven.
		// The two delay ceilings stay undocumented on purpose — the page says
		// "bounded delays" rather than restating millisecond budgets an author
		// cannot usefully budget against — and the label ceiling belongs to the
		// descriptor field, not to the retry envelope, so both are excluded here
		// by name instead of silently by set-equality.
		expectDocumentedLimits({
			sources: [read('packages/plugin-kit/src/sendTransportManifest.ts')],
			declaredPattern: /^const (MAX_\w+) = /gm,
			exclude: new Set(['MAX_LABEL_LENGTH', 'MAX_RETRY_DELAY_MS', 'MAX_TOTAL_DELAY_MS']),
			section: section(docs.contributions, '## Send transports'),
			rendered: {
				MAX_RETRIES: { literal: '3', prose: 'retryDelays: [/* ≤ 3 bounded delays */]' },
			},
		});
	});

	it('documents the plugin-id length ceiling on both pages that state it', () => {
		const pluginId = read('packages/plugin-kit/src/pluginId.ts');
		const declaredPattern = /^const (MAX_PLUGIN_ID_LENGTH) = /gm;
		expectDocumentedLimits({
			sources: [pluginId],
			declaredPattern,
			section: section(docs.overview, '## Anatomy of a plugin'),
			rendered: {
				MAX_PLUGIN_ID_LENGTH: {
					literal: '64',
					prose: '| `id` | Lowercase kebab-case, ≤ 64 characters.',
				},
			},
		});
		expectDocumentedLimits({
			sources: [pluginId],
			declaredPattern,
			section: section(docs.troubleshooting, '## Manifest errors'),
			rendered: {
				MAX_PLUGIN_ID_LENGTH: {
					literal: '64',
					prose: '`id` is not lowercase kebab-case ≤ 64 chars',
				},
			},
		});
	});

	it('documents every manifest ceiling the validator enforces', () => {
		const snapshot = read('packages/plugin-kit/src/manifestSnapshot.ts');
		const schema = read('packages/plugin-kit/src/settingsSchema.ts');
		// `MAX_ARRAY_LENGTH` guards a hostile `length` at the `unknown` boundary
		// before validation; it is not a ceiling an author can budget against, so
		// it is deliberately absent from the pages.
		const internal = new Set(['MAX_ARRAY_LENGTH']);
		const rendered: Readonly<
			Record<string, { literal: string; authoring: string; troubleshooting: string }>
		> = {
			MAX_CAPABILITIES: {
				literal: '64',
				authoring: '64 capabilities',
				troubleshooting: '64 capabilities',
			},
			MAX_REQUIRED_ENV_VARS: {
				literal: '64',
				authoring: '64 required env vars',
				troubleshooting: '64 env vars',
			},
			MAX_CONTRIBUTIONS_PER_KIND: {
				literal: '256',
				authoring: '256 entries per contribution bucket',
				troubleshooting: '256 entries per bucket',
			},
		};
		const declared = [...snapshot.matchAll(/^const (MAX_\w+) = /gm)]
			.map((match) => match[1]!)
			.filter((name) => !internal.has(name));
		expect(new Set(declared)).toEqual(new Set(Object.keys(rendered)));

		const rules = section(docs.authoring, '### Rules the validator enforces');
		const manifestErrors = section(docs.troubleshooting, '## Manifest errors');
		for (const [name, { literal, authoring, troubleshooting }] of Object.entries(rendered)) {
			expect(snapshot, `${name} is no longer ${literal}`).toContain(`${name} = ${literal};`);
			expect(rules, `${name} (${authoring}) is undocumented`).toContain(authoring);
			expect(manifestErrors, `${name} (${troubleshooting}) is undocumented`).toContain(
				troubleshooting
			);
		}
		// The settings-field ceiling is owned by settingsSchema and shared with the
		// snapshotter, so it is pinned at its source, not at the import.
		expect(schema).toContain('MAX_SETTINGS_FIELDS = 64;');
		expect(rules).toContain('64 settings fields');
		expect(manifestErrors).toContain('64 settings fields');
	});

	it('documents the llmBudget bounds the manifest validator enforces', () => {
		const manifest = read('packages/plugin-kit/src/manifest.ts');
		const check = manifest.slice(
			manifest.indexOf("const dailyUsd = readDataProperty(value, 'dailyUsd'"),
			manifest.indexOf("'$.llmBudget.dailyUsd'")
		);
		expect(check.length).toBeGreaterThan(0);
		expect(check, 'the positive-value bound moved').toContain('dailyUsd.value <= 0');
		expect(check, 'the upper bound moved').toContain('dailyUsd.value > 1_000_000');
		// "At most six decimal places" is enforced as "an integer number of micro-USD".
		expect(check, 'the decimal-place bound moved').toContain(
			'!Number.isSafeInteger(dailyUsd.value * 1_000_000)'
		);
		expect(section(docs.authoring, '### Rules the validator enforces')).toContain(
			'(> 0, ≤ 1,000,000, at most six decimal places)'
		);
		expect(section(docs.troubleshooting, '## Manifest errors')).toContain(
			'must be > 0, ≤ 1 000 000, and expressible with at most six decimal places'
		);
	});

	it('documents every settings-schema ceiling', () => {
		expectDocumentedLimits({
			sources: [read('packages/plugin-kit/src/settingsSchema.ts')],
			declaredPattern: /^export const (MAX_\w+) = /gm,
			section: section(docs.contributions, '## Settings schema'),
			rendered: {
				MAX_TEXT_LENGTH: { literal: '8_192', prose: '8 192 characters per text or secret value' },
				MAX_SETTINGS_FIELDS: { literal: '64', prose: '64 fields' },
				MAX_SETTINGS_OPTIONS: { literal: '64', prose: '64 options per select' },
			},
		});
	});

	it('documents the timeout ceiling for draft strategies and autonomy gates', () => {
		for (const [file, heading] of [
			['packages/plugin-kit/src/draftStrategy.ts', '## Draft strategies'],
			['packages/plugin-kit/src/autonomyGate.ts', '## Autonomy gates (`sendGates`)'],
		] as const) {
			const max = /export const PLUGIN_\w+_TIMEOUT_MAX_MS = ([\w_]+);/.exec(read(file))?.[1];
			expect(max, `${file} no longer declares a 30 s timeout ceiling`).toBe('30_000');
			expect(section(docs.contributions, heading)).toContain('timeoutMs /* ≤ 30 000 */');
		}
	});

	it('documents every hosted mail projection limit', () => {
		// Both projections in one case: the guide describes them in one sentence
		// and their field sets overlap. A new field in either map fails until the
		// sentence names it.
		const declarations = (
			[
				['apps/api/convex/agent/pluginStepRuntime.ts', 'PLUGIN_AGENT_STEP_INPUT_LIMITS'],
				[
					'apps/api/convex/agent/steps/route/pluginAutoSendGates.ts',
					'HOSTED_AUTONOMY_GATE_INPUT_LIMITS',
				],
			] as const
		).map(([file, name]) => {
			const source = read(file);
			const start = source.indexOf(`export const ${name}`);
			expect(start, `${name} moved out of ${file}`).not.toBe(-1);
			return source.slice(start, source.indexOf('});', start));
		});
		expectDocumentedLimits({
			sources: declarations,
			declaredPattern: /^\t(\w+CodePoints):/gm,
			form: 'field',
			section: section(docs.capabilities, '### Untrusted text'),
			rendered: {
				fromCodePoints: { literal: '512', prose: '`from` 512' },
				toCodePoints: { literal: '2_048', prose: '`to` 2 048' },
				subjectCodePoints: { literal: '1_024', prose: '`subject` 1 024' },
				bodyCodePoints: { literal: '64 * 1_024', prose: 'body or draft 65 536' },
				draftCodePoints: { literal: '64 * 1_024', prose: 'body or draft 65 536' },
				classificationCodePoints: {
					literal: '128',
					prose: 'classification an autonomy gate sees 128',
				},
			},
		});
	});

	it('documents every Tier-2 hook byte cap and code-point clamp', () => {
		expectDocumentedLimits({
			sources: [read('apps/api/convex/lib/constants.ts')],
			declaredPattern:
				/export const (CONNECTED_APP_HOOK_MAX_(?:REQUEST|RESPONSE)_BYTES|CONNECTED_APP_HOOK_MAX_\w+_CODE_POINTS) = /g,
			proseFailure: 'has no table row',
			section: section(docs.connectedApps, '### What Owlat enforces on every call'),
			rendered: {
				CONNECTED_APP_HOOK_MAX_REQUEST_BYTES: {
					literal: '64 * 1024',
					prose: '| Request body cap | 64 KiB |',
				},
				CONNECTED_APP_HOOK_MAX_RESPONSE_BYTES: {
					literal: '64 * 1024',
					prose: '| Response body cap | 64 KiB (drained under the cap; over-cap fails closed) |',
				},
				CONNECTED_APP_HOOK_MAX_DRAFT_CODE_POINTS: {
					literal: '64 * 1024',
					prose: '| Accepted draft text | Injection-scrubbed and clamped to 65 536 code points |',
				},
				CONNECTED_APP_HOOK_MAX_REASON_CODE_POINTS: {
					literal: '300',
					prose: '| Accepted reason text | Injection-scrubbed and clamped to 300 code points |',
				},
			},
		});
	});

	it('documents the delivery-log page bounds and retention', () => {
		const constants = read('apps/api/convex/lib/constants.ts');
		expect(constants).toContain('CONNECTED_APP_HOOK_LOG_DEFAULT_LIMIT = 50;');
		expect(constants).toContain('CONNECTED_APP_HOOK_LOG_MAX_LIMIT = 200;');
		expect(constants).toContain('AUDIT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;');
		const logs = section(docs.connectedApps, '## Delivery logs');
		expect(logs).toContain('default 50 rows, maximum 200');
		expect(logs).toContain('retention of 30 days');
	});

	it('quotes the dependency_missing message the codegen actually throws', () => {
		const provenance = read('packages/plugin-codegen/src/packageProvenance.ts');
		const message = /`(Bundled plugin [^`]+)`/.exec(provenance)?.[1];
		expect(message, 'the provenance message moved').toBeTypeOf('string');
		expect(docs.troubleshooting).toContain(message!.replace('${packageName}', '`<name>`'));
	});

	it('lists exactly the files the scaffold writes', () => {
		const scaffold = read('packages/plugin-cli/src/scaffold.ts');
		const written = [...scaffold.matchAll(/files\.set\('([^']+)'/g)].map((match) => match[1]!);
		expect(written.length).toBeGreaterThan(5);
		// The authoring guide draws `src/` as a directory node, so its leaves are
		// the scaffold paths with that prefix removed.
		const expected = new Set(written.map((path) => path.replace(/^src\//, '')));
		const tree = /```text\n(examples\/plugins\/hello-owlat\/[\s\S]*?)```/.exec(docs.authoring)?.[1];
		expect(tree, 'the scaffold tree is no longer on the authoring page').toBeTypeOf('string');
		const listed = new Set(
			[...tree!.matchAll(/── (\S+)/g)]
				.map((match) => match[1]!)
				.filter((name) => !name.endsWith('/'))
		);
		expect(listed).toEqual(expected);
	});

	it('documents every manifest issue code', () => {
		const issueCodes = [
			...read('packages/plugin-kit/src/manifestIssues.ts').matchAll(/\| '([a-z_]+)'/g),
		].map((match) => match[1]!);
		expect(issueCodes.length).toBeGreaterThan(5);
		for (const code of issueCodes) {
			expect(docs.troubleshooting, `issue code ${code} is undocumented`).toContain(`\`${code}\``);
		}
	});
});

describe('plugin docs: untrusted-text controls are described as shipped, not as planned', () => {
	const navigation = read('apps/web/app/lib/dashboardNavigation.ts');
	const conventions = read('apps/api/convex/CONVENTIONS.md');

	it('the browser path really only clamps — the scrub seam has no web caller', () => {
		expect(navigation).toContain(String.raw`.replace(/\p{Cc}|\p{Cf}/gu, '')`);
		expect(navigation).toContain('.slice(0, 64)');
		const callers = sourceFiles('apps/web/app').filter((file) =>
			read(file).includes('applyPluginUntrustedTextPolicy')
		);
		expect(callers, 'a web caller appeared; the docs must be updated to match').toEqual([]);
	});

	/**
	 * The unit the SHIPPED label clamp counts, derived from `clampLabel` itself.
	 * `String.prototype.slice` counts UTF-16 code units; spreading or
	 * `Array.from`-ing the string counts code points. Pinning the doc phrase
	 * alone would bless whichever unit the prose happens to name, so the docs
	 * must instead be checked against the unit the code really uses — and the
	 * other unit must be absent, so a page cannot satisfy this by naming both.
	 */
	function labelClampUnit(): { readonly stated: string; readonly wrong: string } {
		const start = navigation.indexOf('function clampLabel(');
		expect(start, 'clampLabel is gone; the docs describe a clamp that no longer exists').not.toBe(
			-1
		);
		const body = navigation.slice(start, navigation.indexOf('\n}', start));
		const codeUnits = /\.slice\(0, 64\)/.test(body);
		const codePoints = /\[\.\.\.|Array\.from/.test(body);
		expect(codeUnits !== codePoints, `clampLabel clamps ambiguously:\n${body}`).toBe(true);
		return codeUnits
			? { stated: '64 UTF-16 code units', wrong: '64 code points' }
			: { stated: '64 code points', wrong: '64 UTF-16 code units' };
	}

	/** Markdown text with hard wraps collapsed, so a phrase can span lines. */
	function flow(markdown: string): string {
		return markdown.replace(/\s+/g, ' ');
	}

	it('the nav/settings reference describes the clamp, not an injection scrub', () => {
		const nav = flow(section(docs.contributions, '## Navigation and settings entries'));
		const unit = labelClampUnit();
		expect(nav).not.toMatch(/injection.?scrub/i);
		expect(nav, `the shipped clamp counts ${unit.stated}`).toContain(unit.stated);
		expect(nav, `${unit.wrong} is not what clampLabel counts`).not.toContain(unit.wrong);
		expect(nav).toMatch(/bidi/i);
		expect(nav).toMatch(/spoofing/i);
		expect(nav).toMatch(/escap/i);
	});

	it('the backend conventions describe the clamp, not an injection scrub', () => {
		const bullet = flow(
			conventions.slice(
				conventions.indexOf('- Plugin nav and settings entries are data-only links.'),
				conventions.indexOf('- The plugin settings module owns only')
			)
		);
		const unit = labelClampUnit();
		expect(bullet.length).toBeGreaterThan(0);
		expect(bullet).not.toMatch(/injection.?scrub/i);
		expect(bullet, `the shipped clamp counts ${unit.stated}`).toContain(unit.stated);
		expect(bullet, `${unit.wrong} is not what clampLabel counts`).not.toContain(unit.wrong);
		expect(bullet).toMatch(/bidi/i);
	});

	it('the capability guide describes the browser clamp in the shipped unit', () => {
		const untrusted = section(docs.capabilities, '### Untrusted text');
		const browser = flow(untrusted.slice(untrusted.indexOf('Browser-bound plugin text')));
		expect(browser, 'the browser-clamp paragraph moved').toMatch(/^Browser-bound/);
		const unit = labelClampUnit();
		expect(browser, `the shipped clamp counts ${unit.stated}`).toContain(unit.stated);
		expect(browser, `${unit.wrong} is not what clampLabel counts`).not.toContain(unit.wrong);
	});

	it('the manifest validator bounds the label in the same unit the clamp counts', () => {
		// The two layers must agree, or the documented budget is a fiction: the
		// validator rejects a name over its ceiling before `clampLabel` ever sees
		// it. Both count UTF-16 code units today (`.length` and `.slice`).
		const validator = read('packages/plugin-kit/src/navContributionManifest.ts');
		expect(validator).toContain('const MAX_NAME_LENGTH = 64;');
		expect(validator).toContain('name.value.length > MAX_NAME_LENGTH');
		expect(labelClampUnit().stated).toBe('64 UTF-16 code units');
	});

	it('names exactly the Convex boundaries that apply the untrusted-text policy', () => {
		const untrusted = section(docs.capabilities, '### Untrusted text');
		expect(untrusted).toMatch(/Convex-side/);
		expect(untrusted).toMatch(/is \*not\* applied/);

		// Derived rather than asserted one-directionally: the boundaries the guide
		// names must correspond ONE-TO-ONE with the Convex files that call the
		// seam. A fifth caller, a removed caller, or a boundary the guide invents
		// (the plugin host merely DEFINING the policy is not a boundary) all fail.
		const boundaryFileByPhrase: Readonly<Record<string, string>> = {
			'automation step reasons': 'apps/api/convex/automations/steps/pluginStep.ts',
			'autonomy gate reasons': 'apps/api/convex/agent/steps/route/pluginAutoSendGates.ts',
			'connected-app hook text': 'apps/api/convex/connectedApps/hookRuntime.ts',
		};
		const callers = sourceFiles('apps/api/convex').filter((file) =>
			read(file).includes('applyPluginUntrustedTextPolicy')
		);
		expect(
			new Set(callers),
			'the set of Convex callers changed; the security guide must name exactly them'
		).toEqual(new Set(Object.values(boundaryFileByPhrase)));

		const list = /Convex-side boundaries — ([^—]+) — /.exec(untrusted)?.[1];
		expect(list, 'the guide no longer lists its Convex-side boundaries inline').toBeTypeOf(
			'string'
		);
		const named = list!
			.split(/,\s*(?:and\s+)?|\s+and\s+/)
			.map((phrase) => phrase.trim())
			.filter(Boolean);
		expect(new Set(named)).toEqual(new Set(Object.keys(boundaryFileByPhrase)));
		expect(named).toHaveLength(Object.keys(boundaryFileByPhrase).length);
	});

	it('attributes assistant tool scrubbing to the assistant, not to the plugin policy', () => {
		// The assistant is NOT a plugin untrusted-text boundary: `assistantTools`
		// is a reserved bucket, and built-in tool output is scrubbed by a core
		// control of the assistant's own.
		const untrusted = section(docs.capabilities, '### Untrusted text');
		expect(untrusted).toContain('scrubForInjection');
		expect(untrusted).toContain('`assistantTools` is a reserved bucket');
		const toolRegistry = read('apps/api/convex/assistant/toolRegistry.ts');
		expect(toolRegistry).toContain("import { scrubForInjection } from './prompt'");
		expect(toolRegistry).not.toContain('applyPluginUntrustedTextPolicy');
	});
});

describe('plugin docs: the CLI page quotes the real help text', () => {
	const run = read('packages/plugin-cli/src/run.ts');
	const start = run.indexOf('export const USAGE = `') + 'export const USAGE = `'.length;
	const usage = run.slice(start, run.indexOf('`;', start));

	it('reproduces the CLI usage block verbatim', () => {
		expect(usage).toContain('owlat plugins — manage bundled Owlat plugins');
		expect(docs.cli, 'the quoted --help block has drifted from run.ts').toContain(usage);
	});

	it('publishes no internal pipeline id to plugin authors', () => {
		// The help text is user-facing once the docs quote it, and "PP-nn" is an
		// internal work-item id that means nothing to a plugin author.
		expect(usage).not.toMatch(/PP-\d\d/);
		expect(docs.cli).not.toMatch(/PP-\d\d/);
	});
});

describe('plugin docs: the chapter does not promise unshipped extension points', () => {
	it('names the reserved-but-unconsumed buckets as reserved', () => {
		// Derived from the page, not hardcoded: EVERY bucket the chapter calls
		// reserved must really be unconsumed by codegen, so wiring one up fails
		// here until the page stops calling it reserved — and a bucket quietly
		// dropped from the list is caught by the contribution-bucket assertion,
		// which requires every declared kind to be documented somewhere.
		const reserved = section(docs.contributions, '## Declared but not yet consumed');
		const kinds = new Set(contributionKinds());
		const buckets = [...reserved.matchAll(/`([a-zA-Z]+)`/g)]
			.map((match) => match[1]!)
			.filter((name) => kinds.has(name));
		expect(buckets.length).toBeGreaterThan(8);
		const generate = read('packages/plugin-codegen/src/generate.ts');
		for (const bucket of buckets) {
			expect(
				generate,
				`bucket ${bucket} is documented as reserved but codegen reads it`
			).not.toContain(bucket);
		}
	});

	it('states that the import-provider signature contract has no replay defense', () => {
		expect(read('packages/plugin-kit/src/importProvider.ts')).toContain(
			'It carries no replay resistance'
		);
		expect(docs.contributions).toMatch(/no replay resistance/i);
	});
});

describe('plugin docs: every page is reachable', () => {
	const sidebar = read('apps/docs/app/utils/sidebarConfig.ts');

	for (const [key, file] of Object.entries(PAGES)) {
		it(`${file} is linked from the sidebar`, () => {
			const slug = file.replace(/^\d+\./, '').replace(/\.md$/, '');
			expect(sidebar).toContain(`/developer/${slug}`);
			expect(docs[key as keyof typeof PAGES]).toMatch(/^---\ntitle: "/);
		});
	}

	it('has no plugin page left out of the map', () => {
		const files = readdirSync(resolve(repoRoot, CONTENT_DIR)).filter((file) =>
			file.includes('plugin')
		);
		expect(new Set(files)).toEqual(new Set(Object.values(PAGES)));
	});
});

/**
 * The chapter points readers at directories under `examples/`. A cited path that
 * no longer exists is exactly the drift the maintained gallery exists to
 * prevent, so every one is resolved on disk. The single deliberate exception is
 * the tutorial's scaffold output, which the reader creates by running the CLI —
 * that one is pinned to the CLI's own default directory instead.
 */
describe('plugin docs: every cited example directory exists', () => {
	const SCAFFOLD_TUTORIAL_DIRECTORY = 'examples/plugins/hello-owlat';

	const cited = new Set(
		[...chapter.matchAll(/examples\/(?:plugins\/)?[a-z0-9][a-z0-9-]*/g)].map((match) => match[0])
	);

	it('cites the three tier references and the conformance gallery', () => {
		for (const directory of [
			'examples/plugins/escalation-guard',
			'examples/plugins/slack-approvals',
			'examples/plugins/deliverability-lab',
			'examples/conformance',
		]) {
			expect(cited, `${directory} is no longer documented`).toContain(directory);
		}
	});

	it('resolves every cited directory that is not the tutorial scaffold', () => {
		for (const directory of cited) {
			if (directory === SCAFFOLD_TUTORIAL_DIRECTORY || directory === 'examples/plugins') continue;
			expect(
				existsSync(resolve(repoRoot, directory)),
				`the docs cite ${directory}, which does not exist`
			).toBe(true);
		}
	});

	it('keeps the tutorial scaffold path equal to the CLI default', () => {
		const create = read('packages/plugin-cli/src/commands/create.ts');
		expect(create).toContain("join('examples', 'plugins', id)");
		expect(cited).toContain(SCAFFOLD_TUTORIAL_DIRECTORY);
	});
});
