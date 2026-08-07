/**
 * THE SCAFFOLDED PROVIDER, MATERIALISED — the subject of P3.4's conformance gate.
 *
 * P3.3 proved that a HAND-WRITTEN plugin ESP reaches everywhere a provider has to
 * reach. P3.4's claim is narrower and, for D4's "provider N+1 is a package"
 * policy, more load-bearing: that the bundle `owlat plugins create --template
 * send-provider` EMITS is already such a provider, with no author edit in
 * between. A template that scaffolds a package which does not compose is worse
 * than no template, because its failures surface as manifest-validation issues an
 * author reads as their own mistake.
 *
 * SO NOTHING HERE IS HAND-WRITTEN. This module calls the shipped generator
 * (`buildScaffold`), writes its output to a throwaway directory exactly as
 * `runCreate` would, imports the emitted TypeScript, and runs the REAL host
 * composition and the REAL renderer over the emitted manifest — then reads the
 * three generated catalogs back out of the rendered source. Every value the
 * conformance suite feeds to a core module therefore travelled the whole path a
 * real bundle travels: generator → file → module → manifest validation →
 * composition → codegen → artifact.
 *
 * WHY A TEMPORARY DIRECTORY RATHER THAN A CHECKED-IN COPY. A checked-in copy is a
 * copy: it would keep passing after the generator that is supposed to produce it
 * changed, which is precisely the drift this gate exists to catch. Writing the
 * files also exercises the one thing an in-memory map cannot — that the emitted
 * TypeScript PARSES and its imports RESOLVE, which is the first thing an author
 * finds out and the last thing a string comparison would notice.
 *
 * THE MODULE REGISTRIES ARE NOT EVALUATED, for the reason the Mock ESP fixture's
 * composition module gives: codegen emits import statements against a published
 * package specifier, which is not installed. The suite supplies the imported
 * module objects — the emitted ones, discovered from the emitted files rather
 * than named here, so a template that renamed an export is a failure rather than
 * a silent substitution.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildScaffold, type ScaffoldFiles } from '@owlat/plugin-cli/scaffold';
import { renderPluginComposition } from '@owlat/plugin-codegen';
import { composeBundledPlugins, type BundledPlugin } from '@owlat/plugin-host';
import {
	parsePluginId,
	validatePluginManifest,
	type PluginSendTransportDomainIdentityModule,
	type PluginSendTransportModule,
	type PluginSendTransportWebhookModule,
} from '@owlat/plugin-kit';
import { evaluateGeneratedArtifact } from '../../generatedArtifact';
import { REPOSITORY_ROOT } from '../../repository';

/** The plugin id the gate scaffolds under; the composed kind derives from it. */
export const SCAFFOLDED_PLUGIN_ID = parsePluginId('acme-relay');

/**
 * The package a third-party author would publish this bundle as.
 *
 * Deliberately NOT the `@owlat/plugin-<id>` default: the template's job is to
 * start a package that leaves this repository, and a scoped stranger's name is
 * what proves nothing in the generator assumes the workspace scope.
 */
export const SCAFFOLDED_PACKAGE_NAME = '@acme/owlat-relay';

/** One evaluated generated catalog, as an array of plain entries. */
export type GeneratedEntries = readonly Record<string, unknown>[];

export interface ScaffoldedBundle {
	/** The directory the emitted package was written to. */
	readonly directory: string;
	/** Exactly what `buildScaffold` produced, for the "unmodified" assertion. */
	readonly files: ScaffoldFiles;
	/** `bundledPluginComposition`, as the generated roster holds it. */
	readonly roster: readonly BundledPlugin[];
	/** `BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG` as codegen would emit it. */
	readonly sendTransports: GeneratedEntries;
	/** `BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG`. */
	readonly webhooks: GeneratedEntries;
	/** `BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG`. */
	readonly domainIdentities: GeneratedEntries;
	/** The three executable halves, as imported from the emitted files. */
	readonly transport: PluginSendTransportModule;
	readonly webhook: PluginSendTransportWebhookModule;
	readonly domainIdentity: PluginSendTransportDomainIdentityModule;
}

let pending: Promise<ScaffoldedBundle> | undefined;

/**
 * The scaffolded bundle, materialised once.
 *
 * Memoized as the PROMISE rather than the value, because the suite's mock
 * factories each await it from their own module-resolution frame: memoizing after
 * the await would let two frames both start a scaffold, write two directories and
 * hand two different module objects to registries that are supposed to agree.
 */
export function scaffoldedBundle(): Promise<ScaffoldedBundle> {
	pending ??= materialize();
	return pending;
}

/** Remove the directory this fixture wrote, if it wrote one. */
export async function cleanupScaffoldedBundle(): Promise<void> {
	const created = pending;
	pending = undefined;
	if (!created) return;
	await created.then(
		(bundle) => rm(bundle.directory, { recursive: true, force: true }),
		() => undefined
	);
}

async function materialize(): Promise<ScaffoldedBundle> {
	const directory = await mkdtemp(join(tmpdir(), 'owlat-scaffolded-provider-'));
	// The workspace root is the REAL one: the emitted tsconfig and lint script
	// point at it by relative path, and a fake root would emit paths that resolve
	// nowhere — a difference between what this gate drives and what an author gets.
	const files = buildScaffold(
		REPOSITORY_ROOT,
		directory,
		SCAFFOLDED_PLUGIN_ID,
		SCAFFOLDED_PACKAGE_NAME as never,
		'send-provider'
	);
	for (const [path, content] of files) {
		const absolute = join(directory, ...path.split('/'));
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, content, 'utf8');
	}

	// Through the package's ROOT entry, which is what a host imports: `index.ts`
	// re-exports the manifest and nothing else, while `manifest.ts` also exports
	// the header and tolerance constants the author edits.
	const manifest = await importSingleValue(join(directory, 'src', 'index.ts'), 'manifest');
	const validated = validatePluginManifest(manifest);
	if (!validated.ok) {
		throw new Error(
			`the scaffolded manifest must validate: ${validated.issues
				.map((issue) => `${issue.path} ${issue.message}`)
				.join('; ')}`
		);
	}

	const roster = composeBundledPlugins([
		{ packageName: SCAFFOLDED_PACKAGE_NAME, manifest: validated.manifest },
	]);
	const rendered = renderPluginComposition(roster);

	return {
		directory,
		files,
		roster,
		sendTransports: evaluateCatalog(
			rendered.sendTransportCatalog,
			'BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG',
			'send transport'
		),
		webhooks: evaluateCatalog(
			rendered.sendTransportWebhookCatalog,
			'BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG',
			'feedback webhook'
		),
		domainIdentities: evaluateCatalog(
			rendered.sendTransportDomainIdentityCatalog,
			'BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG',
			'sending-domain identity'
		),
		transport: (await importSingleValue(
			join(directory, 'src', 'convex', 'transport.ts'),
			'send'
		)) as PluginSendTransportModule,
		webhook: (await importSingleValue(
			join(directory, 'src', 'convex', 'webhook.ts'),
			'webhook'
		)) as PluginSendTransportWebhookModule,
		domainIdentity: (await importSingleValue(
			join(directory, 'src', 'convex', 'domainIdentity.ts'),
			'domain identity'
		)) as PluginSendTransportDomainIdentityModule,
	};
}

/**
 * One evaluated catalog, required to carry EXACTLY THE ONE ENTRY the template
 * declares.
 *
 * The count is asserted here rather than left to the suite, because a template
 * that dropped a half composes into an EMPTY catalog and the suite's mock
 * factories read `[0]` off it — which fails inside Vitest's module mocker with
 * `Cannot read properties of undefined`, naming neither the half nor the cause.
 * A template missing a bundle half is a template failure, and it should say so.
 */
function evaluateCatalog(source: string, constName: string, half: string): GeneratedEntries {
	const entries = evaluateGeneratedArtifact(source, constName) as GeneratedEntries;
	if (entries.length !== 1) {
		throw new Error(
			`the scaffolded bundle must compose exactly one ${half}, but composed ${entries.length}`
		);
	}
	return entries;
}

/**
 * Import one emitted file and return its single exported VALUE.
 *
 * Discovered rather than named, and the discovery is the assertion: the emitted
 * export names are derived from the plugin id (`acmeRelayTransport`), so naming
 * them here would restate the generator's own convention in a second place —
 * exactly the duplication this plan removes. Requiring EXACTLY ONE value export
 * is what makes the discovery safe: a half that grew a second export would be
 * ambiguous, and this fails rather than picking whichever came first.
 */
async function importSingleValue(path: string, label: string): Promise<unknown> {
	const module = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
	const exported = Object.entries(module).filter(([name]) => name !== 'default');
	if (exported.length !== 1) {
		throw new Error(
			`the scaffolded ${label} half must export exactly one value, but exports ${
				exported.map(([name]) => name).join(', ') || 'nothing'
			}`
		);
	}
	return exported[0]![1];
}
