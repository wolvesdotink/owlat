#!/usr/bin/env bun
/**
 * Docker API isolation, read off the parsed compose file.
 *
 * docker-socket-proxy serves the Docker API unauthenticated, and the grants the
 * updater needs (CONTAINERS + POST) are enough to start a container with a host
 * bind mount. So the proxy sits on the internal `docker-proxy` network and the
 * updater is its only neighbour (#1329).
 *
 * This used to be a line count in check-compose-invariants.sh, which missed
 * every attachment not written as a `      - docker-proxy` block line: flow
 * sequences and maps, quoted names, trailing comments, and `network_mode:
 * service:updater`, which joins the updater's namespace without naming the
 * network at all. Parsing the YAML sees what Compose sees.
 *
 * Two indirections are resolved too. `network_mode: container:<x>` is matched
 * against a member's `container_name` as well as Compose's default
 * `<project>-<service>-<n>` name. And membership is counted by Docker network,
 * not YAML key: a second key whose `name:` (or external name) can resolve to
 * the same network as docker-proxy is an alias, and its services are members.
 * The project name is chosen at deploy time (`-p` and COMPOSE_PROJECT_NAME
 * override a top-level `name:`, and scripts/owlat sets the latter), so any
 * project is assumed.
 *
 * Usage: bun scripts/check-docker-proxy-network.ts <compose-file>
 * Prints one violation per line and exits 1 when there are any; exits 2 when
 * the file cannot be read as a compose file.
 */

const NETWORK = 'docker-proxy';
const PROXY = 'docker-socket-proxy';
const UPDATER = 'updater';
const MEMBERS = [PROXY, UPDATER];

type Service = {
	container_name?: unknown;
	networks?: unknown;
	network_mode?: unknown;
	ports?: unknown;
};

type Network = { internal?: unknown; name?: unknown; external?: unknown } | null;

type Compose = {
	services?: Record<string, Service | null>;
	networks?: Record<string, Network>;
};

/**
 * The Docker network a key creates or joins: a fixed name, `<project>_<key>`,
 * or a name that interpolation decides at deploy time.
 */
type NetworkName = { exact: string } | { scoped: string } | 'unresolved';

/** The networks a service joins, as Compose resolves them (no key = default). */
function attachedNetworks(service: Service): string[] {
	if (service.network_mode !== undefined) return [];
	const { networks } = service;
	if (networks === undefined || networks === null) return ['default'];
	if (Array.isArray(networks)) return networks.map(String);
	if (typeof networks === 'object') return Object.keys(networks);
	return [String(networks)];
}

/** Whether `network_mode` puts a service inside a member's network namespace. */
function sharesMemberNamespace(
	networkMode: string,
	services: Record<string, Service | null>
): boolean {
	const [kind, rawTarget = ''] = networkMode.split(':', 2);
	const target = rawTarget.trim();
	if (kind === 'service') return MEMBERS.includes(target);
	if (kind !== 'container') return false;
	return MEMBERS.some((member) => {
		const containerName = services[member]?.container_name;
		if (typeof containerName === 'string' && target === containerName) return true;
		// Compose's default <project>-<service>-<n>; any project, so match the service.
		return target.includes(member);
	});
}

function networkName(key: string, network: Network): NetworkName {
	const literal = (value: unknown): NetworkName => {
		const name = String(value);
		return name.includes('$') ? 'unresolved' : { exact: name };
	};
	if (network?.name !== undefined) return literal(network.name);
	const { external } = network ?? {};
	// The legacy `external: { name: x }` form still works in Compose v2.
	if (external && typeof external === 'object' && 'name' in external) {
		return literal((external as { name: unknown }).name);
	}
	// An external network is joined by its key, unprefixed.
	if (external === true) return { exact: key };
	return { scoped: key };
}

/** Whether two network keys can end up on the same Docker network. */
function sameNetwork(a: NetworkName, b: NetworkName): boolean {
	if (a === 'unresolved' || b === 'unresolved') return true;
	if ('exact' in a && 'exact' in b) return a.exact === b.exact;
	if ('scoped' in a && 'scoped' in b) return a.scoped === b.scoped;
	const exact = 'exact' in a ? a.exact : (b as { exact: string }).exact;
	const scoped = 'scoped' in a ? a.scoped : (b as { scoped: string }).scoped;
	// <project>_<key> for a project only known at deploy time.
	return exact.endsWith(`_${scoped}`);
}

function describeName(name: NetworkName): string {
	if (name === 'unresolved') return 'a name interpolated at deploy time';
	return 'exact' in name
		? `name ${name.exact}`
		: `the project-scoped name <project>_${name.scoped}`;
}

function dockerProxyViolations(compose: Compose): string[] {
	const violations: string[] = [];
	const services = compose.services ?? {};

	const networks: Record<string, Network> = { default: null, ...compose.networks };
	if (networks[NETWORK]?.internal !== true) {
		violations.push(`must declare the ${NETWORK} network with internal: true`);
	}

	const protectedName = networkName(NETWORK, networks[NETWORK] ?? null);
	if (protectedName === 'unresolved') {
		violations.push(`${NETWORK} network must not take its name from interpolation`);
	}
	// Every key that is, or may be, the same Docker network as docker-proxy.
	const aliases = new Set([NETWORK]);
	for (const [key, network] of Object.entries(networks)) {
		if (key === NETWORK || protectedName === 'unresolved') continue;
		const name = networkName(key, network);
		if (sameNetwork(protectedName, name)) {
			aliases.add(key);
			violations.push(
				`network ${key} can resolve to the same Docker network as ${NETWORK} (${describeName(name)} vs ${describeName(protectedName)})`
			);
		}
	}

	const members: string[] = [];
	for (const [name, raw] of Object.entries(services)) {
		const service = raw ?? {};
		if (attachedNetworks(service).some((key) => aliases.has(key))) members.push(name);
		if (
			typeof service.network_mode === 'string' &&
			sharesMemberNamespace(service.network_mode, services)
		) {
			violations.push(
				`${name} joins a ${NETWORK} member's network namespace via network_mode: ${service.network_mode}`
			);
		}
	}

	const proxy = services[PROXY];
	if (!proxy) {
		violations.push(`has no ${PROXY} service`);
	} else {
		if (proxy.network_mode !== undefined) {
			violations.push(`${PROXY} must not set network_mode (found ${String(proxy.network_mode)})`);
		}
		const networks = attachedNetworks(proxy);
		if (networks.length !== 1 || networks[0] !== NETWORK) {
			violations.push(
				`${PROXY} must attach to ${NETWORK} only (attached: ${networks.join(', ') || 'none'})`
			);
		}
		if (proxy.ports !== undefined) violations.push(`${PROXY} must publish no port`);
	}

	const updater = services[UPDATER];
	if (!updater) {
		violations.push(`has no ${UPDATER} service`);
	} else {
		if (updater.network_mode !== undefined) {
			violations.push(
				`${UPDATER} must not set network_mode (found ${String(updater.network_mode)})`
			);
		}
		const networks = attachedNetworks(updater);
		if (!networks.includes('default') || !networks.includes(NETWORK)) {
			violations.push(
				`${UPDATER} must attach to both default and ${NETWORK} (attached: ${networks.join(', ') || 'none'})`
			);
		}
	}

	const sorted = [...new Set(members)].sort();
	if (sorted.join(',') !== [...MEMBERS].sort().join(',')) {
		violations.push(
			`${NETWORK} network must hold exactly ${PROXY} and ${UPDATER} (members: ${sorted.join(', ') || 'none'})`
		);
	}

	return violations;
}

if (import.meta.main) {
	const file = Bun.argv[2];
	if (!file) {
		console.error('usage: bun scripts/check-docker-proxy-network.ts <compose-file>');
		process.exit(2);
	}
	let compose: Compose;
	try {
		compose = Bun.YAML.parse(await Bun.file(file).text()) as Compose;
	} catch (error) {
		console.error(`${file}: cannot parse as YAML: ${(error as Error).message}`);
		process.exit(2);
	}
	if (!compose || typeof compose !== 'object' || typeof compose.services !== 'object') {
		console.error(`${file}: no services map`);
		process.exit(2);
	}
	const violations = dockerProxyViolations(compose);
	for (const violation of violations) process.stdout.write(`${violation}\n`);
	process.exit(violations.length > 0 ? 1 : 0);
}
