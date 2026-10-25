/**
 * The Docker API isolation half of scripts/check-compose-invariants.sh.
 *
 * docker-socket-proxy serves the Docker API unauthenticated, and the grants the
 * updater needs (CONTAINERS + POST) are enough to start a container with a host
 * bind mount. It must sit on the internal docker-proxy network with the updater
 * as its only neighbour. The VPS template had it on `default` with every other
 * service while the gate only looked at the root file (#1329), so each case
 * breaks one template in a copy and runs the real gate against it.
 *
 * The network is one route to the engine; the socket is the other, covered in
 * check-compose-socket-access.test.ts (#1368).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	TEMPLATES,
	addIntruder,
	both,
	readTemplate,
	removeSandboxes,
	replaceOnce,
	runGate,
} from './composeGate.testlib';

afterEach(removeSandboxes);

/** Gives an existing service an explicit `container_name`. */
function nameContainer(service: string, containerName: string): (s: string) => string {
	return (s) =>
		replaceOnce(s, `\n  ${service}:\n`, `\n  ${service}:\n    container_name: ${containerName}\n`);
}

/** Declares an extra top-level network next to docker-proxy. */
function addNetwork(body: string): (s: string) => string {
	return (s) =>
		replaceOnce(
			s,
			'  docker-proxy:\n    internal: true\n',
			`  docker-proxy:\n    internal: true\n${body}`
		);
}

const NOT_ONLY_MEMBERS = 'docker-proxy network must hold exactly docker-socket-proxy and updater';
const SHARES_NAMESPACE = "joins a docker-proxy member's network namespace";
const ALIAS = 'can resolve to the same Docker network as docker-proxy';
const WITH_INTRUDER = `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`;

const MUTATIONS = [
	{
		breaks: 'the proxy also attached to default',
		apply: (s: string) =>
			replaceOnce(
				s,
				'      - docker-proxy\n    restart: unless-stopped',
				'      - default\n      - docker-proxy\n    restart: unless-stopped'
			),
		expected:
			'docker-socket-proxy must attach to docker-proxy only (attached: default, docker-proxy)',
	},
	{
		breaks: 'the proxy with no networks key (implicitly on default)',
		apply: (s: string) =>
			replaceOnce(
				s,
				'    networks:\n      - docker-proxy\n    restart: unless-stopped',
				'    restart: unless-stopped'
			),
		expected: 'docker-socket-proxy must attach to docker-proxy only (attached: default)',
	},
	{
		breaks: 'a published proxy port',
		apply: (s: string) =>
			replaceOnce(
				s,
				'    networks:\n      - docker-proxy\n    restart: unless-stopped',
				"    ports:\n      - '127.0.0.1:2375:2375'\n    networks:\n      - docker-proxy\n    restart: unless-stopped"
			),
		expected: 'docker-socket-proxy must publish no port',
	},
	{
		breaks: 'a docker-proxy network that is not internal',
		apply: (s: string) =>
			replaceOnce(
				s,
				'  docker-proxy:\n    internal: true\n',
				'  docker-proxy:\n    driver: bridge\n'
			),
		expected: 'must declare the docker-proxy network with internal: true',
	},
	{
		breaks: 'a third service on docker-proxy (block list)',
		apply: addIntruder('    networks:\n      - docker-proxy\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (flow list)',
		apply: addIntruder('    networks: [default, docker-proxy]\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (flow map)',
		apply: addIntruder('    networks: {docker-proxy: {}}\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (block map)',
		apply: addIntruder('    networks:\n      docker-proxy:\n        aliases: [x]\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (quoted name)',
		apply: addIntruder("    networks:\n      - 'docker-proxy'\n"),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (trailing comment)',
		apply: addIntruder('    networks:\n      - docker-proxy # temporary\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: "a service sharing the updater's namespace",
		apply: addIntruder('    network_mode: service:updater\n'),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: service:updater`,
	},
	{
		breaks: "a service sharing the proxy's namespace",
		apply: addIntruder("    network_mode: 'service:docker-socket-proxy'\n"),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: service:docker-socket-proxy`,
	},
	{
		breaks: "a service sharing the proxy container's namespace",
		apply: addIntruder('    network_mode: container:owlat-docker-socket-proxy-1\n'),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: container:owlat-docker-socket-proxy-1`,
	},
	{
		breaks: "a service sharing the proxy's custom-named container",
		apply: both(
			nameContainer('docker-socket-proxy', 'engine-api'),
			addIntruder('    network_mode: container:engine-api\n')
		),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: container:engine-api`,
	},
	{
		breaks: "a service sharing the updater's custom-named container",
		apply: both(
			nameContainer('updater', 'self-update'),
			addIntruder('    network_mode: container:self-update\n')
		),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: container:self-update`,
	},
	{
		breaks: 'an external network named like the project-scoped docker-proxy',
		apply: both(
			addNetwork('  sidedoor:\n    external: true\n    name: owlat_docker-proxy\n'),
			addIntruder('    networks:\n      - sidedoor\n')
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'a second network key with the same name',
		apply: both(
			addNetwork('  sidedoor:\n    name: owlat_docker-proxy\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: `network sidedoor ${ALIAS} (name owlat_docker-proxy vs the project-scoped name <project>_docker-proxy)`,
	},
	{
		breaks: 'a network using the legacy external-name form',
		apply: both(
			addNetwork('  sidedoor:\n    external:\n      name: owlat_docker-proxy\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'an external network whose key is the project-scoped name',
		apply: both(
			addNetwork('  owlat_docker-proxy:\n    external: true\n'),
			addIntruder("    networks: ['owlat_docker-proxy']\n")
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'the default network renamed onto docker-proxy',
		apply: (s: string) =>
			replaceOnce(s, '\n  default:\n', '\n  default:\n    name: owlat_docker-proxy\n'),
		expected: `network default ${ALIAS}`,
	},
	{
		breaks: 'docker-proxy renamed onto the default network',
		apply: (s: string) =>
			replaceOnce(
				s,
				'  docker-proxy:\n    internal: true\n',
				'  docker-proxy:\n    name: owlat_default\n    internal: true\n'
			),
		expected: `network default ${ALIAS}`,
	},
	{
		breaks: 'a docker-proxy name chosen by interpolation',
		apply: (s: string) =>
			replaceOnce(
				s,
				'  docker-proxy:\n    internal: true\n',
				'  docker-proxy:\n    name: ${PROXY_NET:-owlat_docker-proxy}\n    internal: true\n'
			),
		expected: 'docker-proxy network must not take its name from interpolation',
	},
	{
		// -p and COMPOSE_PROJECT_NAME override a top-level name, so it pins nothing.
		breaks: 'a network named for another project despite a literal project name',
		apply: both(
			(s: string) => `name: owlat\n${s}`,
			addNetwork('  metrics:\n    name: metrics_docker-proxy\n')
		),
		expected: `network metrics ${ALIAS}`,
	},
	{
		breaks: 'an interpolated network attachment (list)',
		apply: addIntruder("    networks: ['${INTRUDER_NETWORK:-docker-proxy}']\n"),
		expected:
			'intruder networks must not use interpolation (found ${INTRUDER_NETWORK:-docker-proxy})',
	},
	{
		breaks: 'an interpolated network attachment (map key)',
		apply: addIntruder("    networks:\n      '${INTRUDER_NETWORK:-docker-proxy}': {}\n"),
		expected:
			'intruder networks must not use interpolation (found ${INTRUDER_NETWORK:-docker-proxy})',
	},
	{
		breaks: 'an interpolated network_mode',
		apply: addIntruder('    network_mode: ${INTRUDER_MODE:-service:updater}\n'),
		expected:
			'intruder network_mode must be a literal value (found ${INTRUDER_MODE:-service:updater})',
	},
	{
		breaks: 'an interpolated container: target',
		apply: addIntruder('    network_mode: container:${PROXY_CONTAINER}\n'),
		expected: 'intruder network_mode must be a literal value (found container:${PROXY_CONTAINER})',
	},
	{
		breaks: 'an interpolated proxy container_name',
		apply: both(
			nameContainer('docker-socket-proxy', '${PROXY_CONTAINER:-engine-api}'),
			addIntruder('    network_mode: service:web\n')
		),
		expected:
			'docker-socket-proxy container_name must not use interpolation (found ${PROXY_CONTAINER:-engine-api})',
	},
	{
		breaks: 'an interpolated updater container_name',
		apply: nameContainer('updater', '${UPDATER_CONTAINER:-self-update}'),
		expected:
			'updater container_name must not use interpolation (found ${UPDATER_CONTAINER:-self-update})',
	},
	{
		breaks: 'another network named by interpolation',
		apply: both(
			addNetwork('  sidedoor:\n    name: ${SIDEDOOR:-owlat_docker-proxy}\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: 'sidedoor network must not take its name from interpolation',
	},
	{
		breaks: 'a member on a network named by interpolation',
		apply: both(
			addNetwork('  sidedoor:\n    name: ${SIDEDOOR:-owlat_docker-proxy}\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'an updater that starts before the proxy answers',
		apply: (s: string) =>
			replaceOnce(
				s,
				'      docker-socket-proxy:\n        condition: service_healthy\n',
				'      docker-socket-proxy:\n        condition: service_started\n'
			),
		expected: 'updater must set DOCKER_HOST=tcp://docker-socket-proxy:2375, wait for the proxy',
	},
	{
		breaks: 'a service extending the proxy',
		apply: addIntruder('    extends:\n      service: docker-socket-proxy\n'),
		expected: 'intruder must not use extends (the gate cannot see the merged definition)',
	},
	{
		breaks: 'a service extending another file',
		apply: addIntruder('    extends:\n      file: other.yml\n      service: web\n'),
		expected: 'intruder must not use extends',
	},
	{
		breaks: 'an include of another compose file',
		apply: (s: string) => `include:\n  - other.yml\n${s}`,
		expected: 'must not use include (the gate only sees this file)',
	},
	{
		breaks: 'any service on the host network',
		apply: addIntruder('    network_mode: host\n'),
		expected:
			'intruder must not use network_mode: host (it reaches internal-network container IPs)',
	},
	{
		breaks: 'a container: target the gate cannot resolve',
		apply: addIntruder('    network_mode: container:3f2a9c1d\n'),
		expected:
			'intruder network_mode: container:3f2a9c1d names a container the gate cannot resolve; use service:<name>',
	},
	{
		breaks: "a service reaching the updater's namespace through another service",
		apply: addIntruder(
			'    network_mode: service:hop\n\n  hop:\n    image: alpine:3\n    network_mode: service:updater\n'
		),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: service:hop`,
	},
	{
		breaks: 'an unsupported network_mode',
		apply: addIntruder('    network_mode: ns:/proc/1/ns/net\n'),
		expected: 'intruder uses unsupported network_mode: ns:/proc/1/ns/net',
	},
	{
		breaks: 'the proxy on the host network',
		apply: (s: string) =>
			replaceOnce(
				s,
				'    networks:\n      - docker-proxy\n    restart: unless-stopped',
				'    network_mode: host\n    restart: unless-stopped'
			),
		expected: 'docker-socket-proxy must not set network_mode (found host)',
	},
] as const;

describe.each(TEMPLATES)('$name keeps the Docker API off the app network', ({ name, env }) => {
	const original = readTemplate(name);

	it('passes the gate as checked in', () => {
		const result = runGate(env, original);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it('accepts the network modes that stay off docker-proxy', () => {
		const result = runGate(
			env,
			addIntruder(
				'    network_mode: service:web\n\n  isolated:\n    image: alpine:3\n    network_mode: none\n'
			)(original)
		);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it.each(MUTATIONS)('rejects $breaks', ({ apply, expected }) => {
		const result = runGate(env, apply(original));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(expected);
	});
});
