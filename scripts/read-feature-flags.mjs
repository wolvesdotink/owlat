/**
 * Prints the instance's feature flags, as the Convex backend resolves them, in
 * the form .owlat-flags.json stores them. `owlat feature --sync` pipes this
 * file into `node` inside the running web container and writes the output to
 * the install directory. That container is on the compose network with the
 * backend and has node on every release, so the read works whatever version a
 * restored stack runs.
 *
 * The flags come from the public `getFeatureFlags` query: the map the Features
 * page shows and its Apply & restart hands the updater, plugin flags included.
 * Releases from before the organizations → workspaces module rename serve it
 * under the old path.
 *
 * Exit 0 with the JSON on stdout, or exit 1 with the reason on stderr.
 */

const CONVEX_URL = (process.env['OWLAT_CONVEX_URL'] || 'http://convex:3210').replace(/\/+$/, '');
const QUERY_PATHS = [
	'workspaces/featureFlags:getFeatureFlags',
	'organizations/featureFlags:getFeatureFlags',
];
const FLAG_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One query over Convex's HTTP API: the value, or the backend's reason. */
async function query(path) {
	const response = await fetch(`${CONVEX_URL}/api/query`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path, args: {}, format: 'json' }),
		signal: AbortSignal.timeout(15_000),
	});
	const body = await response.json().catch(() => null);
	if (body && body.status === 'success') return { ok: true, value: body.value };
	return { ok: false, reason: (body && body.errorMessage) || `HTTP ${response.status}` };
}

/** The value as a flag map, or null when it is not one. */
function flagMap(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	if (entries.length === 0) return null;
	for (const [key, flag] of entries) {
		if (!FLAG_KEY.test(key) || typeof flag !== 'boolean') return null;
	}
	return value;
}

async function main() {
	let firstFailure = '';
	for (const path of QUERY_PATHS) {
		let result;
		try {
			result = await query(path);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return `Could not reach the Convex backend at ${CONVEX_URL}: ${reason}`;
		}
		if (!result.ok) {
			firstFailure ||= `${path}: ${result.reason}`;
			continue;
		}
		const flags = flagMap(result.value);
		if (!flags) return `${path} did not answer with a map of feature flags to booleans.`;
		process.stdout.write(JSON.stringify(flags, null, 2));
		return null;
	}
	return `The backend did not return its feature flags (${firstFailure}).`;
}

const failure = await main();
if (failure) {
	process.stderr.write(`${failure}\n`);
	process.exitCode = 1;
}
