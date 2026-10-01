/**
 * The parts of an in-app update that are about the rollout ITSELF rather than
 * about the release being rolled out: proving up front that the Docker API
 * will let the rollout finish, keeping `docker compose up` from tearing down
 * the two containers the rollout is running through, and handing the updater's
 * own replacement to something that outlives it.
 *
 * All three exist because of the same class of bug: the updater drives Docker
 * from INSIDE the stack it is updating, so anything it stops mid-flight, it
 * stops with itself in it.
 */
import { hostname } from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@owlat/shared';
import { COMPOSE_SHADOWED_VARS, exec, OWLAT_DIR } from './http.js';
import { verifyReadiness } from './readiness.js';
import { shutdownSignal } from './lifecycle.js';

interface RolloutStep {
	step: string;
	ok?: boolean;
	stdout: string;
	stderr: string;
}

/**
 * The containers the rollout runs THROUGH. `docker compose up -d` recreates
 * every service whose image or config changed — which, on any release, is the
 * updater itself, and on any change to the proxy's stanza, the Docker API the
 * updater is speaking through. Compose recreate is "rename old → create new →
 * stop old → start new", and the stop kills the compose process (it lives in
 * the updater) or its transport (it goes through the proxy) BEFORE the new
 * container is started: the rollout truncates, and what is left behind is a
 * created-but-never-started updater and half a stack still on the old release.
 *
 * So `up` skips both, `scheduleUpdaterRecreate` hands the updater's own
 * replacement to a helper container, and the proxy — a third-party image with
 * static config, which only changes when we change its stanza — is left to the
 * host (`docker compose up -d docker-socket-proxy`, or `owlat upgrade`).
 */
const SELF_PLUMBING_SERVICES = ['updater', 'docker-socket-proxy'] as const;

/** Compose service names, which are what we interpolate into a shell command. */
const SAFE_SERVICE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Image refs, mount paths and network names, likewise. */
const SAFE_ARG = /^[A-Za-z0-9_/][A-Za-z0-9_.:@/=-]*$/;

/** Docker's 403 body is HTML across several lines; make it fit one log line. */
function oneLine(text: string, max = 300): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

const PROXY_REMEDIATION =
	'The Docker API this updater talks to denies endpoints the rollout needs. ' +
	'Instances installed before 0.5.1 run docker-socket-proxy with NETWORKS=0 ' +
	'and VOLUMES=0, which 403s `docker compose up` and `docker compose run`. ' +
	'On the host: pull the new docker-compose.yml, then ' +
	'`docker compose up -d docker-socket-proxy` (or run `owlat upgrade`), and retry.';

const STACK_DOWN_REMEDIATION =
	'On the host, in the install directory: `docker compose up -d` (or ' +
	'`owlat start`) restarts every service on the release that was just promoted.';

/**
 * Start whatever a failed `up` left stopped.
 *
 * `up` is the one step of a rollout with nothing to roll back to — by the time
 * it runs, the images are pulled, the schema is deployed and the compose file
 * is promoted — and it is also the only step that can take the instance
 * offline. Compose recreate is "create new → stop old → start new", so a
 * command that dies in the middle leaves old containers stopped and new ones
 * created-but-never-started: every service in the plan is down, and until now
 * the operator got a bare "docker compose up failed" for it and a dark
 * instance. (That is not hypothetical — it is what a pre-0.5.1 updater did to
 * itself on every release, by recreating the socket proxy it speaks Docker
 * through.)
 *
 * So recovery is FORWARD, and deliberately smaller than the command that just
 * failed: the same services, no `--remove-orphans`, no `--force-recreate`.
 * Finishing a half-applied recreate is exactly what a second `up -d` does; a
 * stack that just proved it cannot take one set of changes is no place to try
 * a larger one. When even that does not restore the fleet — the transport
 * itself is gone, say — the step carries the host-side command that will.
 */
async function recoverStack(services: string[]): Promise<RolloutStep> {
	const step = 'up-recovery';
	const compose = await composeArgv();
	const retry = await exec('docker', [...compose, 'up', '-d', ...services], OWLAT_DIR);
	// Not "is every container `running`": a service can be running and failing
	// its healthcheck, or running for the second it takes to crash. Readiness is
	// the same contract a successful rollout has to meet, on a shorter bound: the
	// answer carries the host-side command that restarts the stack, and it has
	// to reach the caller before the caller gives up on the request.
	const readiness = await verifyReadiness(services, compose, { recovery: true });

	if (retry.ok && readiness.ready) {
		return {
			step,
			ok: true,
			stdout:
				'A second `up` started every service the failed one left stopped, and they passed the ' +
				`readiness check — the instance is serving again, on the release that was already promoted. ${readiness.summary}`,
			stderr: '',
		};
	}

	return {
		step,
		ok: false,
		stdout: retry.stdout,
		stderr: `${oneLine(retry.stderr) || (retry.ok ? 'the retry started the services' : 'the retry failed')} — ${readiness.summary} ${STACK_DOWN_REMEDIATION}`,
	};
}

/**
 * Never let the recovery itself be the reason the caller hears nothing.
 *
 * No catch-all wraps the update handler, so a throw from here would hang a
 * request that is already reporting a possibly-dark instance — losing the one
 * message that carries the host command to bring it back.
 */
export async function recoverStackAfterFailedUp(services: string[]): Promise<RolloutStep> {
	try {
		return await recoverStack(services);
	} catch (err) {
		return {
			step: 'up-recovery',
			ok: false,
			stdout: '',
			stderr: `${errorMessage(err)} — ${STACK_DOWN_REMEDIATION}`,
		};
	}
}

/**
 * Refuse to start a rollout the Docker API cannot finish.
 *
 * Read-only probes of the two endpoint groups `compose up`/`compose run` reach
 * for before they touch a container. Without this the first casualty is the
 * convex-deploy step, five minutes and one staged compose file in, reported to
 * the operator as the uninformative "convex-deploy failed".
 */
export async function dockerApiPreflight(signal?: AbortSignal): Promise<RolloutStep> {
	const probes = [
		{ endpoint: '/networks', args: ['network', 'ls', '--format', '{{.Name}}'] },
		{ endpoint: '/volumes', args: ['volume', 'ls', '--format', '{{.Name}}'] },
	];

	const denied: string[] = [];
	for (const probe of probes) {
		const result = await exec('docker', probe.args, OWLAT_DIR, { signal });
		if (!result.ok) denied.push(`${probe.endpoint}: ${oneLine(result.stderr) || 'command failed'}`);
	}

	if (denied.length === 0) {
		return {
			step: 'docker-api-preflight',
			ok: true,
			stdout: 'Docker API answers every endpoint the rollout needs',
			stderr: '',
		};
	}

	return {
		step: 'docker-api-preflight',
		ok: false,
		stdout: '',
		stderr: `${denied.join(' | ')} — ${PROXY_REMEDIATION}`,
	};
}

/**
 * The install directory as the HOST sees it — which is not the path this
 * container sees it at.
 *
 * Compose resolves a relative bind (`./Caddyfile:/etc/caddy/Caddyfile`) against
 * the project directory and sends the result to the daemon as a HOST path. Run
 * from in here, `./` is `/owlat`, so a recreate hands the daemon `/owlat/...`:
 * a path that does not exist on the host, which Docker helpfully creates as an
 * empty directory and mounts over the real config. The bind that put this
 * container's install dir at OWLAT_DIR is the one thing that knows the real
 * path, so read it back off ourselves.
 */
async function hostInstallDir(): Promise<string | null> {
	const self = await inspectSelf();
	const bind = self?.binds.find((mount) => mount.split(':')[1] === OWLAT_DIR);
	return bind?.split(':')[0] ?? null;
}

/** The compose files an unqualified `docker compose` in OWLAT_DIR would load. */
function defaultComposeFiles(): string[] {
	const files = [join(OWLAT_DIR, 'docker-compose.yml')];
	const override = join(OWLAT_DIR, 'docker-compose.override.yml');
	if (existsSync(override)) files.push(override);
	return files;
}

/**
 * `docker compose`, told where the project really lives.
 *
 * `--project-directory` fixes relative bind resolution; it also moves where
 * compose looks for the compose files and `.env`, so both are named explicitly
 * at the paths THIS container can read. The project name is derived from the
 * directory's basename either way, so the containers keep their names.
 *
 * Falls back to a bare `docker compose` (cwd = OWLAT_DIR) when the host path
 * cannot be read back — an updater running outside a container, or a path with
 * a character this refuses to interpolate. That is the behaviour this had
 * before, relative binds and all.
 */
/**
 * The same invocation as `composeCommand`, as an argv for `exec`.
 *
 * This is the form every caller in this process wants: `exec` runs
 * an argv with no shell, so a path holding a space is one argument rather
 * than two, and nothing here has to be quoted. `composeCommand` survives for
 * the single case that genuinely needs a command LINE — the `sh -c` payload
 * handed to the helper container below, which is interpreted by that
 * container's shell and not by this one.
 */
export async function composeArgv(files: string[] = []): Promise<string[]> {
	const hostDir = await hostInstallDir();
	const envFile = join(OWLAT_DIR, '.env');
	if (!hostDir || hostDir === OWLAT_DIR) {
		return ['compose', ...files.flatMap((file) => ['-f', file])];
	}

	const chosen = files.length > 0 ? files : defaultComposeFiles();
	return [
		'compose',
		'--project-directory',
		hostDir,
		...(existsSync(envFile) ? ['--env-file', envFile] : []),
		...chosen.flatMap((file) => ['-f', file]),
	];
}

export async function composeCommand(files: string[] = []): Promise<string> {
	const hostDir = await hostInstallDir();
	const envFile = join(OWLAT_DIR, '.env');
	if (!hostDir || hostDir === OWLAT_DIR) {
		return ['docker compose', ...files.map((file) => `-f ${file}`)].join(' ');
	}

	const chosen = files.length > 0 ? files : defaultComposeFiles();
	return [
		'docker compose',
		`--project-directory ${hostDir}`,
		existsSync(envFile) ? `--env-file ${envFile}` : '',
		...chosen.map((file) => `-f ${file}`),
	]
		.filter(Boolean)
		.join(' ');
}

/**
 * The services `up` should recreate: everything compose would have started for
 * the active profiles, minus the rollout's own plumbing.
 *
 * `docker compose config --services` already filters by COMPOSE_PROFILES, so
 * this never starts a profile-gated service (`convex-deploy`, `code-worker`)
 * that a plain `up` would have left alone.
 */
export async function servicesToRecreate(): Promise<{ services: string[]; error?: string }> {
	const listed = await exec(
		'docker',
		[...(await composeArgv()), 'config', '--services'],
		OWLAT_DIR
	);
	if (!listed.ok) {
		return { services: [], error: `cannot read the service list: ${oneLine(listed.stderr)}` };
	}

	const all = listed.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	const unsafe = all.filter((name) => !SAFE_SERVICE.test(name));
	if (unsafe.length > 0) {
		return {
			services: [],
			error: `refusing to run compose for service names: ${unsafe.join(', ')}`,
		};
	}

	const services = all.filter(
		(name) => !(SELF_PLUMBING_SERVICES as readonly string[]).includes(name)
	);
	if (services.length === 0) {
		return { services: [], error: 'the compose file declares no updatable service' };
	}

	return { services };
}

interface SelfContainer {
	image: string;
	binds: string[];
	networks: string[];
}

/** What this very container was created with — the plumbing a helper must clone. */
async function inspectSelf(): Promise<SelfContainer | null> {
	const format =
		'{{.Config.Image}}{{"\\n"}}{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}:{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}{{end}}{{"\\n"}}{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}';
	const result = await exec('docker', ['inspect', hostname(), '--format', format], OWLAT_DIR);
	if (!result.ok) return null;

	const [image = '', mounts = '', networks = ''] = result.stdout.split('\n');
	const container: SelfContainer = {
		image: image.trim(),
		binds: mounts.split(' ').filter(Boolean),
		networks: networks.split(' ').filter(Boolean),
	};

	const everyArg = [container.image, ...container.binds, ...container.networks];
	if (!container.image || everyArg.some((arg) => !SAFE_ARG.test(arg))) return null;
	return container;
}

/**
 * The file the helper below waits for before it replaces this container,
 * relative to the install directory (the helper's working directory, and this
 * process's OWLAT_DIR).
 */
const REPLACEMENT_RELEASE_FILE = '.owlat-updater-release';

/**
 * How long the helper waits for the release before it goes ahead anyway. The
 * release normally comes within milliseconds of the helper starting; waiting
 * out the cap means this process died before it could say so, and replacing
 * it is then exactly what is wanted.
 */
const REPLACEMENT_WAIT_SECONDS = 60;

/** Set while a helper is waiting for `releaseUpdaterReplacement`. */
let replacementPending = false;

/**
 * Start a short-lived helper container that recreates the `updater` service
 * once this request has been answered and this process is free to be stopped.
 *
 * The helper is a clone of the updater's own plumbing: the image it is already
 * running (so nothing is pulled, and the bytes are the ones already verified),
 * its bind mounts (so the install dir with the promoted compose file is there)
 * and its networks (so `DOCKER_HOST` still resolves). It holds no secret, and
 * it reaches Docker exactly the way the updater does — through the proxy, never
 * the raw socket. `--rm` collects it when the compose command returns.
 *
 * It does not act on a timer. Recreating the updater stops this process, so a
 * helper that fired on a fixed delay could stop it while the rollout that
 * started the helper was still writing its answer. It waits for this process to
 * write REPLACEMENT_RELEASE_FILE instead, which the request listener does once
 * the rollout's answer is out (`releaseUpdaterReplacement`).
 *
 * Failing here is not fatal to the update: every other service is already on
 * the new release, and the updater simply stays on the old image until the next
 * host-side `docker compose up -d`.
 */
async function scheduleUpdaterRecreate(): Promise<RolloutStep> {
	const step = 'self-update';
	const self = await inspectSelf();
	if (!self) {
		return {
			step,
			ok: false,
			stdout: '',
			stderr:
				'Cannot inspect this container, so the updater was not replaced. ' +
				'Run `docker compose up -d updater` on the host to finish.',
		};
	}

	const dockerHost = process.env['DOCKER_HOST'];
	if (dockerHost && !SAFE_ARG.test(dockerHost)) {
		return { step, ok: false, stdout: '', stderr: 'Refusing to pass on an unsafe DOCKER_HOST' };
	}

	// A release left over from an earlier helper would let this one go at once.
	await rm(join(OWLAT_DIR, REPLACEMENT_RELEASE_FILE), { force: true });

	const [firstNetwork, ...restNetworks] = self.networks;
	const args = [
		'run',
		'-d',
		'--rm',
		'--label',
		'ink.wolves.owlat.role=self-update-helper',
		...(firstNetwork ? ['--network', firstNetwork] : []),
		...(dockerHost ? ['-e', `DOCKER_HOST=${dockerHost}`] : []),
		...self.binds.flatMap((bind) => ['-v', bind]),
		'-w',
		OWLAT_DIR,
		'--entrypoint',
		'sh',
		self.image,
		'-c',
		// Interpreted by the HELPER container's shell, so this one stays a
		// command line — hence `composeCommand` rather than `composeArgv`.
		//
		// The `unset` is the helper's half of what `childEnv` does for the
		// updater. The helper runs the updater's own image, which bakes
		// `OWLAT_VERSION` at the release it was BUILT at — the one being
		// replaced — and compose would let that shadow the `.env` this rollout
		// just pinned, so the updater's replacement would come up reporting the
		// version it was supposed to leave behind.
		`unset ${COMPOSE_SHADOWED_VARS.join(' ')}; ` +
			`i=0; while [ ! -e ${REPLACEMENT_RELEASE_FILE} ] && [ $i -lt ${REPLACEMENT_WAIT_SECONDS} ]; do sleep 1; i=$((i+1)); done; ` +
			`rm -f ${REPLACEMENT_RELEASE_FILE}; ` +
			`${await composeCommand()} up -d --no-deps updater`,
	];

	const started = await exec('docker', args, OWLAT_DIR);
	if (!started.ok) {
		return {
			step,
			ok: false,
			stdout: '',
			stderr:
				`Could not start the helper that replaces the updater: ${oneLine(started.stderr)}. ` +
				'Run `docker compose up -d updater` on the host to finish.',
		};
	}
	replacementPending = true;

	// A helper on one network cannot see the others; the updater is on two
	// (`default` for the web app, `docker-proxy` for the Docker API) and its
	// replacement command needs the same reach.
	const helperId = started.stdout.trim().split('\n').pop()?.trim() ?? '';
	const connectErrors: string[] = [];
	for (const network of restNetworks) {
		const connected = await exec('docker', ['network', 'connect', network, helperId], OWLAT_DIR);
		if (!connected.ok) connectErrors.push(`${network}: ${oneLine(connected.stderr)}`);
	}

	return {
		step,
		ok: true,
		stdout:
			`Updater replacement handed to helper ${helperId.slice(0, 12)} (once this answer is sent). ` +
			'docker-socket-proxy is left to the host — recreate it there if its config changed.',
		stderr: connectErrors.join(' | '),
	};
}

/**
 * Never let a plumbing failure take down a rollout that already succeeded.
 *
 * And no helper while this process is being stopped: whatever is stopping it
 * decides what runs next, and a helper that recreated the updater in the middle
 * of a `docker compose down` would bring back a service the operator is taking
 * down, on a network compose is trying to remove.
 */
export async function scheduleUpdaterRecreateSafely(): Promise<RolloutStep> {
	if (shutdownSignal().aborted) {
		return {
			step: 'self-update',
			ok: false,
			stdout: '',
			stderr:
				'The updater is shutting down, so it did not schedule its own replacement. ' +
				'Run `docker compose up -d updater` on the host to finish.',
		};
	}
	try {
		return await scheduleUpdaterRecreate();
	} catch (err) {
		return { step: 'self-update', ok: false, stdout: '', stderr: errorMessage(err) };
	}
}

/**
 * Let a waiting helper replace this container. Called by the request listener
 * once the rollout that scheduled it has written its answer; a no-op when none
 * did. Best-effort: a release that cannot be written costs the helper its
 * wait cap, not the replacement.
 *
 * Synchronous on purpose: it runs while the rollout lock is still held, and a
 * caller that has its answer may send the next request at once. An await here
 * would let that request in while the lock is still taken, and answer it 409.
 */
export function releaseUpdaterReplacement(): void {
	if (!replacementPending) return;
	replacementPending = false;
	try {
		writeFileSync(join(OWLAT_DIR, REPLACEMENT_RELEASE_FILE), '', { mode: 0o600 });
	} catch (err) {
		console.error('[update] could not release the updater replacement:', err);
	}
}
