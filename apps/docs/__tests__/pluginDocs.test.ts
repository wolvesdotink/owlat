import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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
	const capabilityConstants: ReadonlyArray<[string, string]> = [
		['sendTransport.ts', 'send:transport'],
		['autonomyGate.ts', 'send:gate'],
		['agentStep.ts', 'agent:step'],
		['draftStrategy.ts', 'draft:strategy'],
		['webhookEvent.ts', 'webhooks:publish'],
		['importProvider.ts', 'imports:provide'],
		['cron.ts', 'scheduler:cron'],
		['navItem.ts', 'ui:navigation'],
		['settingsPanel.ts', 'ui:settings'],
		['workerTask.ts', 'worker:enqueue'],
	];

	for (const [file, capability] of capabilityConstants) {
		it(`documents ${capability} exactly as ${file} defines it`, () => {
			expect(read(`packages/plugin-kit/src/${file}`)).toContain(`'${capability}' as const`);
			expect(docs.capabilities).toContain(`\`${capability}\``);
			expect(docs.contributions).toContain(`\`${capability}\``);
		});
	}

	for (const capability of ['automation:trigger', 'automation:step', 'automation:condition']) {
		it(`documents ${capability}`, () => {
			expect(read('packages/plugin-kit/src/automation.ts')).toContain(`'${capability}' as const`);
			expect(docs.capabilities).toContain(`\`${capability}\``);
		});
	}

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

describe('plugin docs: limits match the constants the host enforces', () => {
	it('documents the cron scheduling and timeout envelope', () => {
		const cron = read('packages/plugin-kit/src/cron.ts');
		expect(cron).toContain('PLUGIN_CRON_MIN_INTERVAL_MINUTES = 15');
		expect(cron).toContain('PLUGIN_CRON_TIMEOUT_MAX_MS = 5 * 60_000');
		expect(docs.contributions).toMatch(/15\s*…\s*40 320/);
		expect(docs.contributions).toMatch(/1 000\s*…\s*300 000/);
	});

	it('documents the Tier-3 worker envelope', () => {
		const worker = read('packages/plugin-kit/src/workerTask.ts');
		expect(worker).toContain('PLUGIN_WORKER_MAX_ATTEMPTS = 5');
		expect(worker).toContain('PLUGIN_WORKER_TIMEOUT_MAX_MS = 15 * 60_000');
		expect(worker).toContain('PLUGIN_WORKER_PAYLOAD_MAX_BYTES = 64 * 1024');
		expect(worker).toContain('PLUGIN_WORKER_MAX_PENDING_JOBS = 100');
		expect(docs.sandboxedJobs).toMatch(/1 … 5/);
		expect(docs.sandboxedJobs).toMatch(/1 s … 15 min/);
		expect(docs.sandboxedJobs).toContain('64 KiB');
		expect(docs.sandboxedJobs).toContain('100 `queued` + `running`');
	});

	it('documents the plugin-storage quotas', () => {
		const storage = read('apps/api/convex/plugins/storageJson.ts');
		expect(storage).toContain('maxEntries: 1_000');
		expect(storage).toContain('maxTotalBytes: 10 * 1024 * 1024');
		expect(storage).toContain('maxListPageSize: 100');
		expect(docs.capabilities).toContain('1 000');
		expect(docs.capabilities).toContain('10 MiB');
	});

	it('documents the Tier-2 hook envelope', () => {
		const constants = read('apps/api/convex/lib/constants.ts');
		expect(constants).toContain('CONNECTED_APP_HOOK_TIMEOUT_MS = 5_000');
		expect(constants).toContain('CONNECTED_APP_HOOK_RESPONSE_TOLERANCE_MS = 30_000');
		expect(constants).toContain('CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD = 5');
		expect(constants).toContain('CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS = 60_000');
		expect(docs.connectedApps).toContain('5 s');
		expect(docs.connectedApps).toContain('30 s');
		expect(docs.connectedApps).toContain('60 s');
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

	it('the nav/settings reference describes the clamp, not an injection scrub', () => {
		const nav = section(docs.contributions, '## Navigation and settings entries');
		expect(nav).not.toMatch(/injection.?scrub/i);
		expect(nav).toContain('64 code points');
		expect(nav).toMatch(/bidi/i);
		expect(nav).toMatch(/spoofing/i);
		expect(nav).toMatch(/escap/i);
	});

	it('the backend conventions describe the clamp, not an injection scrub', () => {
		const bullet = conventions.slice(
			conventions.indexOf('- Plugin nav and settings entries are data-only links.'),
			conventions.indexOf('- The plugin settings module owns only')
		);
		expect(bullet.length).toBeGreaterThan(0);
		expect(bullet).not.toMatch(/injection.?scrub/i);
		expect(bullet).toMatch(/64 code points/);
		expect(bullet).toMatch(/bidi/i);
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
