import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	validateKnownFields,
	validateUniqueFormattedStringArray,
} from './manifestValue';
import type { SendTransportConfigEnvVar } from './sendTransportManifest';

const ENV_VAR = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate the flag, and report back the environment variables it makes a
 * precondition of enablement.
 */
export function validateFlag(value: unknown, issues: PluginManifestIssue[]): ReadonlySet<string> {
	if (value === undefined) return new Set();
	if (!isRecord(value)) {
		addManifestIssue(issues, 'invalid_type', '$.flag', 'must be a plain object');
		return new Set();
	}
	validateKnownFields(value, '$.flag', new Set(['default', 'requiredEnvVars']), issues);
	const defaultValue = readDataProperty(value, 'default', issues, true, '$.flag');
	if (defaultValue.kind === 'value' && typeof defaultValue.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', '$.flag.default', 'must be a boolean');
	}
	const requiredEnvVars = readDataProperty(value, 'requiredEnvVars', issues, false, '$.flag');
	if (requiredEnvVars.kind !== 'value') return new Set();
	const items = validateUniqueFormattedStringArray(requiredEnvVars.value, issues, {
		path: '$.flag.requiredEnvVars',
		format: ENV_VAR,
		formatMessage: 'must be an uppercase environment variable name',
		duplicateLabel: 'environment variable',
	});
	return new Set(
		(items ?? []).flatMap((item) =>
			item.kind === 'value' && typeof item.value === 'string' ? [item.value] : []
		)
	);
}

/**
 * A feedback webhook's signing secret must also be a flag requirement.
 *
 * `signature.secretEnvVar` is not configuration the route can do without: with
 * the variable unset the host cannot verify anything and answers EVERY delivery
 * `503` — and a run of non-2xx is exactly what makes a provider deactivate an
 * endpoint, so the failure mode is "this transport's feedback stops arriving,
 * permanently", visible to the operator only as a log line. `flag.requiredEnvVars`
 * is the one mechanism that turns a missing variable into something an operator
 * sees BEFORE it matters: the host's flag mutation refuses to turn a plugin ON
 * while a required variable is absent, and the Features surface names the ones
 * that are. Requiring the join here means an author cannot ship the combination
 * that fails silently.
 *
 * SCOPE: the feedback webhook only. An import provider also declares a signature
 * contract, but its bucket is `'declared'` — no host path routes to it, so a
 * missing secret there cannot cost anyone a live channel. When that bucket is
 * wired, its secret joins this rule.
 */
export function requireWebhookSecretsAreFlagRequirements(
	webhookSecretEnvVars: readonly string[],
	flagRequiredEnvVars: ReadonlySet<string>,
	issues: PluginManifestIssue[]
): void {
	for (const secretEnvVar of webhookSecretEnvVars) {
		if (flagRequiredEnvVars.has(secretEnvVar)) continue;
		addManifestIssue(
			issues,
			'missing',
			'$.flag.requiredEnvVars',
			`must list ${secretEnvVar}, the feedback webhook's signing secret — without it every delivery is refused and the plugin should not be enableable`
		);
	}
}

/**
 * A send transport's own configuration variable may NOT be one of the plugin's
 * flag requirements — the mirror image of the rule above, and the reason both
 * facts leave the contribution validator together.
 *
 * "Set the token to enable the pack" is a natural thing to write, and the two
 * lists accept the same names, so nothing about the manifest looks wrong. What
 * breaks is downstream and permanent: the host composes a transport's presence
 * gate as the UNION of the two lists, but only the transport's own variables are
 * instance-scoped. A name in both is therefore read under the `__<INSTANCEKEY>`
 * suffix for a named instance, so `plugin.acme.x#eu` counts as configured on
 * `PLUGIN_ACME_TOKEN__EU` alone while the deployment-wide variable that gates the
 * whole plugin is never checked. The transport is then listed, resolved, routed
 * to — and refused by the authorization path on every single send, because the
 * plugin is off. Not stale for a moment: wrong until someone edits the manifest.
 *
 * The two scopes are the whole point, so the fix is to name them differently
 * (`PLUGIN_ACME_ENABLED` for the pack, `PLUGIN_ACME_TOKEN` for the transport) and
 * this says so where the author can still do it.
 */
export function refuseFlagVariablesAsTransportConfig(
	configEnvVars: readonly SendTransportConfigEnvVar[],
	flagRequiredEnvVars: ReadonlySet<string>,
	issues: PluginManifestIssue[]
): void {
	for (const declared of configEnvVars) {
		if (!flagRequiredEnvVars.has(declared.name)) continue;
		addManifestIssue(
			issues,
			'duplicate',
			declared.path,
			`must not name ${declared.name}, which $.flag.requiredEnvVars already claims — a flag variable gates the whole plugin and is read unsuffixed, while a transport's own variable is read per instance as ${declared.name}__<INSTANCEKEY>`
		);
	}
}
