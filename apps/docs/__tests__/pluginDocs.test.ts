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
 *      assertions — so no sample can drift into pseudocode;
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

/** Every fenced ```ts block on a page. */
function typescriptFences(markdown: string): string[] {
	return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd());
}

describe('plugin docs: samples are the executable source, verbatim', () => {
	for (const { region, page } of REGION_MAP) {
		it(`${PAGES[page]} quotes the "${region}" sample exactly`, () => {
			const source = regionSource(region);
			expect(source.length).toBeGreaterThan(0);
			const fences = typescriptFences(docs[page]);
			const matching = fences.filter((fence) => fence.includes(source));
			expect(
				matching.length,
				`no \`\`\`ts fence in ${PAGES[page]} contains the "${region}" region verbatim`
			).toBeGreaterThan(0);
		});
	}

	it('covers every region defined in the executable sample file', () => {
		const declared = [...samplesSource.matchAll(/\/\/ #region ([a-z-]+)\n/g)].map((m) => m[1]!);
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
			expect(docs.capabilities).toContain(capability);
			expect(docs.contributions).toContain(capability);
		});
	}

	for (const capability of ['automation:trigger', 'automation:step', 'automation:condition']) {
		it(`documents ${capability}`, () => {
			expect(read('packages/plugin-kit/src/automation.ts')).toContain(`'${capability}' as const`);
			expect(docs.capabilities).toContain(capability);
		});
	}

	it('documents every contribution bucket the manifest type declares', () => {
		const contributions = read('packages/plugin-kit/src/contributions.ts');
		const kinds = [
			...contributions
				.slice(
					contributions.indexOf('PLUGIN_CONTRIBUTION_KINDS = ['),
					contributions.indexOf('] as const;')
				)
				.matchAll(/'([a-zA-Z]+)'/g),
		].map((match) => match[1]!);
		expect(kinds.length).toBeGreaterThan(15);
		for (const kind of kinds) {
			expect(docs.contributions, `bucket ${kind} is undocumented`).toContain(kind);
		}
	});

	it('lists exactly the API scopes the backend recognises', () => {
		const scopes = read('apps/api/convex/auth/apiScopes.ts');
		const declared = [
			...scopes
				.slice(scopes.indexOf('ENDPOINT_SCOPES = ['), scopes.indexOf('export const API_SCOPES'))
				.matchAll(/'([a-z-]+:[a-z-]+)'/g),
		].map((match) => match[1]!);
		expect(declared.length).toBeGreaterThan(5);
		for (const scope of declared) {
			expect(docs.capabilities, `scope ${scope} is undocumented`).toContain(scope);
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
		const codes = [...log.matchAll(/v\.literal\('([a-z_]+)'\)/g)].map((match) => match[1]!);
		const reasons = codes.filter(
			(code) => !['draft', 'gate', 'score', 'app', 'fallback'].includes(code)
		);
		expect(reasons.length).toBeGreaterThan(15);
		for (const reason of reasons) {
			expect(
				docs.troubleshooting + docs.connectedApps,
				`reason ${reason} is undocumented`
			).toContain(reason);
		}
	});

	it('documents every host error code and codegen error code', () => {
		const hostCodes = [
			...read('packages/plugin-host/src/errors.ts').matchAll(/\| '([a-z_]+)'/g),
		].map((match) => match[1]!);
		expect(hostCodes.length).toBeGreaterThan(8);
		for (const code of hostCodes) {
			expect(docs.troubleshooting, `host code ${code} is undocumented`).toContain(code);
		}

		const codegenCodes = [
			...read('packages/plugin-codegen/src/errors.ts').matchAll(/\| '([a-z_]+)'/g),
		].map((match) => match[1]!);
		expect(codegenCodes.length).toBeGreaterThan(10);
		for (const code of codegenCodes) {
			expect(docs.troubleshooting, `codegen code ${code} is undocumented`).toContain(code);
		}
	});

	it('documents every manifest issue code', () => {
		const issueCodes = [
			...read('packages/plugin-kit/src/manifestIssues.ts').matchAll(/\| '([a-z_]+)'/g),
		].map((match) => match[1]!);
		expect(issueCodes.length).toBeGreaterThan(5);
		for (const code of issueCodes) {
			expect(docs.troubleshooting, `issue code ${code} is undocumented`).toContain(code);
		}
	});
});

describe('plugin docs: untrusted-text controls are described as shipped, not as planned', () => {
	const navigation = read('apps/web/app/lib/dashboardNavigation.ts');
	const conventions = read('apps/api/convex/CONVENTIONS.md');

	/** Every source file under the web app, so "no caller" can be asserted. */
	function webSources(dir: string): string[] {
		const files: string[] = [];
		for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
			if (entry.name === 'node_modules') continue;
			if (entry.isDirectory()) files.push(...webSources(`${dir}/${entry.name}`));
			else if (/\.(ts|vue)$/.test(entry.name)) files.push(`${dir}/${entry.name}`);
		}
		return files;
	}

	it('the browser path really only clamps — the scrub seam has no web caller', () => {
		expect(navigation).toContain(String.raw`.replace(/\p{Cc}|\p{Cf}/gu, '')`);
		expect(navigation).toContain('.slice(0, 64)');
		const callers = webSources('apps/web/app').filter((file) =>
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

	it('the security guide scopes the scrub to the boundaries that apply it', () => {
		const untrusted = section(docs.capabilities, '### Untrusted text');
		expect(untrusted).toMatch(/Convex-side/);
		expect(untrusted).toMatch(/is \*not\* applied/);
		// Every boundary the guide names must be a real caller of the seam.
		for (const [phrase, file] of [
			['automation step reasons', 'apps/api/convex/automations/steps/pluginStep.ts'],
			['autonomy gate reasons', 'apps/api/convex/agent/steps/route/pluginAutoSendGates.ts'],
			['assistant tool output', 'packages/plugin-host/src/host.ts'],
			['connected-app hook text', 'apps/api/convex/connectedApps/hookRuntime.ts'],
		] as const) {
			expect(untrusted, `boundary "${phrase}" is not named`).toContain(phrase);
			expect(read(file), `${file} does not apply the policy`).toContain(
				'applyPluginUntrustedTextPolicy'
			);
		}
	});
});

describe('plugin docs: the chapter does not promise unshipped extension points', () => {
	it('names the reserved-but-unconsumed buckets as reserved', () => {
		// These buckets exist in the manifest type but no codegen or host seam
		// consumes them; the docs must say so rather than imply they work.
		for (const bucket of ['assistantTools', 'emailBlocks', 'panels', 'widgets', 'taskCards']) {
			expect(read('packages/plugin-codegen/src/generate.ts')).not.toContain(bucket);
		}
		expect(docs.contributions).toContain('Declared but not yet consumed');
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
