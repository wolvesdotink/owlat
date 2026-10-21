/**
 * Docker socket access, read off the parsed compose file (#1368).
 *
 * Isolating docker-socket-proxy on the internal docker-proxy network only helps
 * if the proxy is the one way to the Docker engine. A service on `network_mode:
 * none` still gets the full, unfiltered API through the socket itself, and a
 * read-only mount does not narrow that: `:ro` stops writes to the socket file,
 * not API calls over it. So only the proxy may reach the socket, by any route
 * Compose offers:
 *
 * - a bind mount of the socket or of a directory above it (`/var/run`, `/`),
 *   in short or long syntax, whatever the target and mode;
 * - a named volume, secret or config backed by such a host path;
 * - `volumes_from` a service that has the socket, followed through chains;
 * - `use_api_socket: true`, which mounts the engine socket by itself.
 *
 * What the gate cannot resolve from the file fails closed, as in the network
 * check: a variable with no default anywhere in a short-syntax mount (it may
 * supply the whole mount) or in a long-syntax source or type, an unknown mount
 * type, a host path with a `..` segment (the kernel follows links before it
 * climbs, so `/var/run/..` is `/`, not `/var`), a path through procfs
 * (`/proc/1/root/run` is the host's /run), an external volume, `volumes_from`
 * a container instead of a service, and named pipes. A
 * `${VAR:-default}` is checked with its default, which is what a deploy that
 * leaves VAR unset mounts; the variable itself is the operator's choice, not
 * this file's. Every decision is taken on the interpolated value.
 */
import { posix } from 'node:path';

const PROXY = 'docker-socket-proxy';
const NO_SOCKET = `only ${PROXY} may reach the Docker engine`;

/** Where the engine listens; /var/run is a symlink to /run on current distros. */
const SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];

/**
 * procfs, and the /dev links into it. Its links lead anywhere on the host:
 * `/proc/1/root/run` is the host's /run, and `/proc/<pid>/cwd` and the fd links
 * open whatever directory a process holds. A path through them names nothing
 * the gate can resolve, so the whole tree fails closed.
 */
const PROCFS = ['/proc', '/dev/fd', '/dev/stdin', '/dev/stdout', '/dev/stderr'];

type Service = {
	use_api_socket?: unknown;
	volumes?: unknown;
	volumes_from?: unknown;
};

type Compose = {
	services?: Record<string, unknown>;
	volumes?: Record<string, unknown>;
	secrets?: Record<string, unknown>;
	configs?: Record<string, unknown>;
};

/** Stands in for a variable the gate cannot resolve; it never occurs in a path. */
const UNSET = '\u0000';

/**
 * Interpolates `value` as a deploy that sets no variables would: defaults are
 * taken, and a variable without one (or a required `:?` one) becomes UNSET.
 * Innermost first, so nested defaults resolve like Compose's.
 */
function interpolate(value: string): string {
	const ESCAPED = '\u0001';
	let text = value.replaceAll('$$', ESCAPED);
	for (;;) {
		const next = text
			.replace(/\$\{[^{}]*\}/g, (match) => {
				const body = match.slice(2, -1);
				const fallback = /^[A-Za-z_][A-Za-z0-9_]*:?-/.exec(body);
				return fallback ? body.slice(fallback[0].length) : UNSET;
			})
			.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, UNSET);
		if (next === text) break;
		text = next;
	}
	return text.replaceAll('$', UNSET).replaceAll(ESCAPED, '$');
}

/**
 * Why a host path gives the Docker socket away, or undefined when it does not.
 * Every host path a service can name (bind sources, volume devices, secret and
 * config files) comes through here.
 *
 * The check is lexical, so it only accepts paths a lexical reading gets right.
 * A `..` segment is not one: the kernel follows a link before it climbs, so
 * `/var/run/../proc/1/root/run` climbs from /run (where /var/run points) to
 * `/proc`, while a lexical reading lands on `/var/proc/...`. Which components
 * are links depends on the host, so any `..` fails closed; this also covers a
 * relative path climbing out of the project directory, which the file does not
 * know. Without `..`, normalizing only drops `.` segments and repeated slashes,
 * which mean the same thing to the kernel.
 */
function hostPathViolation(path: string): string | undefined {
	const relative = !path.startsWith('/');
	if (path.split('/').includes('..')) {
		return `has a .. segment (${path}), which the kernel resolves after following links, so the gate cannot tell where it lands; ${NO_SOCKET}`;
	}
	let normalized = posix.normalize(relative ? path.replace(/^~(?=\/|$)/, '.') : path);
	if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
	if (
		!relative &&
		PROCFS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
	) {
		return `goes through procfs (${path}), whose links reach any host path, the Docker socket included; ${NO_SOCKET}`;
	}
	const prefix = normalized === '/' ? '/' : `${normalized}/`;
	const reaches =
		posix.basename(normalized) === 'docker.sock' ||
		(!relative && SOCKETS.some((socket) => socket === normalized || socket.startsWith(prefix)));
	return reaches ? `gives the Docker socket away (${path}); ${NO_SOCKET}` : undefined;
}

const unresolvedSource = (raw: string): string =>
	`takes its source from interpolation the gate cannot resolve (${raw}); give the variable a default`;

/** Checks a mount source with `check` once interpolation is resolved. */
function sourceViolation(
	raw: unknown,
	check: (source: string) => string | undefined
): string | undefined {
	if (typeof raw !== 'string') return `has a source that is not a string (${String(raw)})`;
	const source = interpolate(raw);
	return source.includes(UNSET) ? unresolvedSource(raw) : check(source);
}

/** Long-syntax mount types that never take a host path or a named volume. */
const SOCKET_FREE_TYPES = new Set(['tmpfs', 'image']);

/** Compose reads a short-syntax source as a host path when it looks like one. */
const isHostPath = (source: string): boolean => /^[./~]/.test(source);

/** Why a top-level volume is unsafe to mount, or undefined. */
function namedVolumeViolation(name: string, compose: Compose): string | undefined {
	const volume = compose.volumes?.[name];
	if (!volume || typeof volume !== 'object') return undefined;
	const { external, driver_opts: options } = volume as {
		external?: unknown;
		driver_opts?: unknown;
	};
	if (external !== undefined && external !== false) {
		return `uses external volume ${name}, which the gate cannot see into`;
	}
	const device = (options as { device?: unknown } | null | undefined)?.device;
	if (device === undefined) return undefined;
	const violation = sourceViolation(device, hostPathViolation);
	return violation && `uses volume ${name}, whose device ${violation}`;
}

/** The problem with one `volumes` entry, or undefined when it cannot reach the socket. */
function mountViolation(entry: unknown, compose: Compose): string | undefined {
	const named = (name: string) => namedVolumeViolation(name, compose);
	if (typeof entry === 'string') {
		// Compose interpolates before it splits on ':', so a value may hold one: an
		// unresolved variable anywhere may supply the whole mount (`${MOUNT}`), and
		// what looks like an anonymous volume is only one when nothing is unresolved.
		const resolved = interpolate(entry);
		if (resolved.includes(UNSET)) return unresolvedSource(entry);
		const [source = '', ...rest] = resolved.split(':');
		if (rest.length === 0) return undefined; // an anonymous volume: target only
		return isHostPath(source) ? hostPathViolation(source) : named(source);
	}
	if (!entry || typeof entry !== 'object') return 'is neither a string nor a mapping';
	const { type: rawType, source } = entry as { type?: unknown; source?: unknown };
	// Branch on the type Compose ends up with, not on how the file spells it.
	const type = typeof rawType === 'string' ? interpolate(rawType) : UNSET;
	if (type.includes(UNSET)) {
		return `has a mount type the gate cannot resolve (${String(rawType)})`;
	}
	if (type === 'npipe') {
		return `is a named pipe, the Docker engine's transport on Windows; ${NO_SOCKET}`;
	}
	if (type === 'bind') return sourceViolation(source, hostPathViolation);
	if (type === 'volume' || type === 'cluster') {
		return source === undefined ? undefined : sourceViolation(source, named);
	}
	if (SOCKET_FREE_TYPES.has(type)) return undefined;
	return `has a mount type the gate does not know (${String(rawType)})`;
}

/** The service a `volumes_from` entry names, or why it cannot be resolved. */
function volumesFromTarget(entry: unknown): { service: string } | { violation: string } {
	if (typeof entry !== 'string' || entry.includes('$')) {
		return { violation: `volumes_from ${String(entry)} must be a literal service name` };
	}
	if (entry.startsWith('container:')) {
		return {
			violation: `volumes_from ${entry} names a container the gate cannot resolve; use a service name`,
		};
	}
	return { service: entry.replace(/:(ro|rw)$/, '') };
}

const asList = (value: unknown): unknown[] =>
	value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

export function socketAccessViolations(compose: Compose): string[] {
	const violations: string[] = [];
	const services = compose.services ?? {};

	for (const kind of ['secrets', 'configs'] as const) {
		for (const [name, definition] of Object.entries(compose[kind] ?? {})) {
			const file = (definition as { file?: unknown } | null)?.file;
			if (file === undefined) continue;
			const violation = sourceViolation(file, hostPathViolation);
			if (violation) violations.push(`${kind.slice(0, -1)} ${name} file ${violation}`);
		}
	}

	// Services that hold the socket, or may: an unresolvable mount counts. The
	// proxy is meant to.
	const holders = new Set([PROXY]);
	const inherits = new Map<string, string[]>();
	for (const [name, raw] of Object.entries(services)) {
		const service = (raw ?? {}) as Service;
		const isProxy = name === PROXY;

		if (!isProxy && service.use_api_socket !== undefined && service.use_api_socket !== false) {
			violations.push(`${name} must not set use_api_socket (${NO_SOCKET})`);
		}

		if (service.volumes !== undefined && !Array.isArray(service.volumes)) {
			violations.push(`${name} volumes must be a list`);
		}
		for (const entry of asList(service.volumes)) {
			const violation = mountViolation(entry, compose);
			if (!violation) continue;
			holders.add(name);
			if (!isProxy) violations.push(`${name} volume ${JSON.stringify(entry)} ${violation}`);
		}

		const sources: string[] = [];
		for (const entry of asList(service.volumes_from)) {
			const target = volumesFromTarget(entry);
			if ('violation' in target) violations.push(`${name} ${target.violation}`);
			else sources.push(target.service);
		}
		inherits.set(name, sources);
	}

	// volumes_from copies every mount, socket included, and chains: follow it.
	const inherited = new Map<string, string>();
	for (let grew = true; grew;) {
		grew = false;
		for (const [name, sources] of inherits) {
			const from = inherited.has(name) ? undefined : sources.find((s) => holders.has(s));
			if (from === undefined) continue;
			inherited.set(name, from);
			holders.add(name);
			grew = true;
		}
	}
	for (const [name, from] of inherited) {
		if (name === PROXY) continue;
		violations.push(
			`${name} inherits Docker socket access from ${from} via volumes_from (${NO_SOCKET})`
		);
	}

	return violations;
}
