import {
	forEachContributionItem,
	validateContributionLabel,
	validateContributionLocalId,
	validateContributionModule,
} from './contributionManifest';
import { validateInboundSignatureContract } from './inboundSignatureManifest';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import { readDataProperty, type DataProperty } from './manifestValue';

const MAX_LABEL_LENGTH = 100;
const FIELDS = new Set(['id', 'label', 'module', 'signature', 'attestSource']);

export function validateImportProviderContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	forEachContributionItem(items, 'importProviders', FIELDS, issues, (provider, path) => {
		validateContributionLocalId(provider, path, ids, 'import provider', issues);
		validateContributionLabel(provider, path, MAX_LABEL_LENGTH, issues);
		validateContributionModule(provider, path, issues);
		validateSignature(provider, path, issues);
		validateAttestSource(provider, path, issues);
	});
}

/**
 * The inbound signature-verification contract is mandatory: a plugin that
 * sources events into Owlat must declare how the host verifies their
 * authenticity before any plugin-produced data is trusted.
 *
 * `replay: 'forbidden'` — the field rules are shared with the send-transport
 * feedback webhook (`./inboundSignatureManifest.ts`), and the one difference is
 * that no HTTP surface dispatches import-provider callbacks yet. Accepting
 * replay provisions here would let a manifest declare a defense the host never
 * runs; the piece that opens that surface flips this to `'required'`.
 */
function validateSignature(
	provider: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const signature = readDataProperty(provider, 'signature', issues, true, path);
	if (signature.kind !== 'value') return;
	validateInboundSignatureContract(signature.value, `${path}.signature`, 'forbidden', issues);
}

function validateAttestSource(
	provider: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const attestSource = readDataProperty(provider, 'attestSource', issues, false, path);
	if (
		attestSource.kind === 'value' &&
		(typeof attestSource.value !== 'string' ||
			attestSource.value.trim().length < 1 ||
			attestSource.value.length > 64)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.attestSource`,
			'must be a non-empty string of at most 64 characters'
		);
	}
}
