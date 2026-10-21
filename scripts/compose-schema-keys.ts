/**
 * Top-level and service keys, checked against the Compose specification (#1368).
 *
 * The Docker API checks only see the keys they know about. Compose rejects an
 * unknown key, but it also keeps growing new ones (`use_api_socket` is recent
 * and mounts the engine socket by itself), so the allowlist pins the set the
 * gate was written against: a key a later Compose adds fails the gate until it
 * is added here, instead of passing silently.
 * `x-` extension keys are free-form in Compose and allowed here too.
 *
 * The lists are the `properties` of the top level and of `$defs.service` in
 * compose-spec.json as embedded in Docker Compose v5.5. When a newer Compose
 * adds a key a template needs, add it here after checking it gives no route to
 * the Docker engine (see docker-socket-access.ts).
 */

const TOP_LEVEL_KEYS = new Set([
	'configs',
	'include',
	'models',
	'name',
	'networks',
	'secrets',
	'services',
	'version',
	'volumes',
]);

const SERVICE_KEYS = new Set([
	'annotations',
	'attach',
	'blkio_config',
	'build',
	'cap_add',
	'cap_drop',
	'cgroup',
	'cgroup_parent',
	'command',
	'configs',
	'container_name',
	'cpu_count',
	'cpu_percent',
	'cpu_period',
	'cpu_quota',
	'cpu_rt_period',
	'cpu_rt_runtime',
	'cpu_shares',
	'cpus',
	'cpuset',
	'credential_spec',
	'depends_on',
	'deploy',
	'develop',
	'device_cgroup_rules',
	'devices',
	'dns',
	'dns_opt',
	'dns_search',
	'domainname',
	'entrypoint',
	'env_file',
	'environment',
	'expose',
	'extends',
	'external_links',
	'extra_hosts',
	'gpus',
	'group_add',
	'healthcheck',
	'hostname',
	'image',
	'init',
	'ipc',
	'isolation',
	'label_file',
	'labels',
	'links',
	'logging',
	'mac_address',
	'mem_limit',
	'mem_reservation',
	'mem_swappiness',
	'memswap_limit',
	'models',
	'network_mode',
	'networks',
	'oom_kill_disable',
	'oom_score_adj',
	'pid',
	'pids_limit',
	'platform',
	'ports',
	'post_start',
	'pre_start',
	'pre_stop',
	'privileged',
	'profiles',
	'provider',
	'pull_policy',
	'pull_refresh_after',
	'read_only',
	'restart',
	'runtime',
	'scale',
	'secrets',
	'security_opt',
	'shm_size',
	'stdin_open',
	'stop_grace_period',
	'stop_signal',
	'storage_opt',
	'sysctls',
	'tmpfs',
	'tty',
	'ulimits',
	'use_api_socket',
	'user',
	'userns_mode',
	'uts',
	'volumes',
	'volumes_from',
	'working_dir',
]);

const isExtension = (key: string): boolean => key.startsWith('x-');

/** One violation per key that is neither in the specification nor an extension. */
export function unknownKeyViolations(compose: Record<string, unknown>): string[] {
	const violations: string[] = [];
	for (const key of Object.keys(compose)) {
		if (!TOP_LEVEL_KEYS.has(key) && !isExtension(key)) {
			violations.push(`has unknown top-level key ${key} (not in the Compose specification)`);
		}
	}
	const services = (compose['services'] ?? {}) as Record<string, unknown>;
	for (const [name, service] of Object.entries(services)) {
		if (!service || typeof service !== 'object') continue;
		for (const key of Object.keys(service)) {
			if (!SERVICE_KEYS.has(key) && !isExtension(key)) {
				violations.push(
					`${name} has unknown service key ${key} (not in the Compose specification)`
				);
			}
		}
	}
	return violations;
}
