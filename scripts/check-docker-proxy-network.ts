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
 * Usage: bun scripts/check-docker-proxy-network.ts <compose-file>
 * Prints one violation per line and exits 1 when there are any; exits 2 when
 * the file cannot be read as a compose file.
 */

const NETWORK = 'docker-proxy';
const PROXY = 'docker-socket-proxy';
const UPDATER = 'updater';
const MEMBERS = [PROXY, UPDATER];

type Service = {
	networks?: unknown;
	network_mode?: unknown;
	ports?: unknown;
};

type Compose = {
	services?: Record<string, Service | null>;
	networks?: Record<string, { internal?: unknown } | null>;
};

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
function sharesMemberNamespace(networkMode: string): boolean {
	const [kind, target = ''] = networkMode.split(':', 2);
	if (kind === 'service') return MEMBERS.includes(target.trim());
	// Compose names containers <project>-<service>-<n> unless container_name is set.
	if (kind === 'container') return MEMBERS.some((member) => target.includes(member));
	return false;
}

function dockerProxyViolations(compose: Compose): string[] {
	const violations: string[] = [];
	const services = compose.services ?? {};

	if (compose.networks?.[NETWORK]?.internal !== true) {
		violations.push(`must declare the ${NETWORK} network with internal: true`);
	}

	const members: string[] = [];
	for (const [name, raw] of Object.entries(services)) {
		const service = raw ?? {};
		if (attachedNetworks(service).includes(NETWORK)) members.push(name);
		if (typeof service.network_mode === 'string' && sharesMemberNamespace(service.network_mode)) {
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
