/**
 * Container-fleet health: parse `docker compose ps --format json` and judge it.
 *
 * Two questions an operator cannot currently get answered anywhere, and which
 * a real install got wrong silently:
 *
 *   1. VERSION DRIFT — `docker-compose.yml` pins every Owlat image to
 *      `${OWLAT_VERSION:-dev}`, so the CONFIGURED version (`.env`, and the git
 *      checkout it came with) and the RUNNING version (the tag of the image each
 *      container was actually created from) are two different facts. Advancing
 *      `.env` without `docker compose up -d` leaves them diverged, and every
 *      version surface in the product reports the configured value — so the
 *      product confidently reports a version it is not running.
 *   2. A container that is up in name only — crash-looping in `restarting`, or
 *      `running` but failing its healthcheck. `docker compose ps` still lists it,
 *      so anything that merely COUNTS services calls a crash-loop healthy.
 *
 * Pure and dependency-free (no `node:` imports) so both the `owlat doctor` CLI
 * and the updater sidecar can share one definition of "the fleet is fine".
 */

/** One row of `docker compose ps --format json`, normalized. */
export interface ComposeService {
	service: string;
	/** Lowercase lifecycle state: `running`, `restarting`, `exited`, `dead`, … */
	state: string;
	/** Human status line, e.g. `Restarting (1) 5 seconds ago`. */
	status: string;
	/** Full image reference, e.g. `ghcr.io/wolvesdotink/web:0.4.12`. */
	image: string;
	/** Tag portion of `image`, e.g. `0.4.12`. Empty when the ref carries no tag. */
	imageTag: string;
	/** Healthcheck verdict: `healthy`, `unhealthy`, `starting`, or empty. */
	health: string;
}

export interface ContainerFinding {
	ok: boolean;
	message: string;
}

/**
 * Split an image reference into repository and tag. Internal: exercised
 * through `parseComposePs` (which reports the tag) and `isOwlatOwnedImage`.
 *
 * Naive `split(':').pop()` is wrong for a registry that carries a PORT
 * (`registry.example.com:5000/owlat/web`) — it would return `5000/owlat/web` as
 * the "tag". Only a colon after the final `/` introduces a tag. A digest pin
 * (`repo@sha256:…`) has no tag at all.
 */
function splitImageRef(image: string): { repository: string; tag: string } {
	const atIndex = image.indexOf('@');
	const ref = atIndex === -1 ? image : image.slice(0, atIndex);
	const lastColon = ref.lastIndexOf(':');
	const lastSlash = ref.lastIndexOf('/');
	if (lastColon === -1 || lastColon < lastSlash) return { repository: ref, tag: '' };
	return { repository: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
}

/**
 * Is this image one the Owlat release pins to `${OWLAT_VERSION}`? Internal:
 * exercised through `evaluateVersionDrift`, which only judges owned images.
 *
 * Only these may be compared against the configured version. Third-party pins
 * (`redis:7.4-alpine`, `caddy:2.8-alpine`, `ghcr.io/get-convex/convex-backend`,
 * `alpine`, `ollama/ollama`, `tecnativa/docker-socket-proxy`) carry their own
 * independent versions and would otherwise all report as drifted.
 */
function isOwlatOwnedImage(image: string): boolean {
	const { repository } = splitImageRef(image);
	// Published release images, and the two images compose builds locally
	// (`owlat-code-worker`, `owlat-convex-fn-proxy`) — both are pinned to
	// OWLAT_VERSION exactly like the published ones.
	return repository.startsWith('ghcr.io/wolvesdotink/') || repository.startsWith('owlat-');
}

/**
 * Parse the output of `docker compose ps --format json`.
 *
 * Accepts BOTH shapes Compose has shipped: a single JSON array, and NDJSON (one
 * object per line). Which one you get depends on the Compose version installed
 * on the box, so a parser that assumes either alone silently produces garbage on
 * half the fleet. Unparseable input yields `[]` rather than throwing — every
 * caller here is a diagnostic that must still report its other findings.
 */
export function parseComposePs(stdout: string): ComposeService[] {
	const text = stdout.trim();
	if (!text) return [];

	const rows: unknown[] = [];
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) rows.push(...parsed);
		else rows.push(parsed);
	} catch {
		// Not a single JSON document — treat it as NDJSON and skip junk lines.
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				rows.push(JSON.parse(trimmed));
			} catch {
				continue;
			}
		}
	}

	const services: ComposeService[] = [];
	for (const row of rows) {
		if (typeof row !== 'object' || row === null) continue;
		const record = row as Record<string, unknown>;
		const str = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');
		const image = str('Image');
		services.push({
			service: str('Service'),
			state: str('State').toLowerCase(),
			status: str('Status'),
			image,
			imageTag: splitImageRef(image).tag,
			health: str('Health').toLowerCase(),
		});
	}
	return services;
}

/**
 * A container is fine when it is `running` and not failing its healthcheck.
 * Internal: exercised through `evaluateContainerStates`.
 */
function isServiceHealthy(service: ComposeService): boolean {
	return service.state === 'running' && service.health !== 'unhealthy';
}

/**
 * Flag containers that are listed but not actually serving.
 *
 * Emits one finding per BAD service, plus a single passing summary when the
 * whole fleet is fine — a checklist with one green line per container drowns the
 * red ones. `docker compose ps` (without `-a`) already omits the one-shot init
 * containers that exit on purpose (`imap-cert-init`, `convex-deploy`), so a
 * legitimately-finished job is never reported as a failure.
 */
export function evaluateContainerStates(services: ComposeService[]): ContainerFinding[] {
	if (services.length === 0) return [];

	const unhealthy = services.filter((service) => !isServiceHealthy(service));
	if (unhealthy.length === 0) {
		return [{ ok: true, message: `all ${services.length} running container(s) are healthy` }];
	}

	return unhealthy.map((service) => {
		const detail = service.status || service.state || 'unknown state';
		const reason =
			service.health === 'unhealthy' && service.state === 'running'
				? 'is failing its healthcheck'
				: `is not running (${service.state || 'unknown'})`;
		return {
			ok: false,
			message: `container "${service.service}" ${reason} — ${detail}`,
		};
	});
}

/**
 * Compare each Owlat container's RUNNING image tag against the CONFIGURED
 * version from `.env`.
 *
 * Returns `[]` when there is no configured version to compare against — an
 * absent `OWLAT_VERSION` is a different problem, reported by the env checks, and
 * guessing here would turn one failure into a cascade of misleading ones.
 */
export function evaluateVersionDrift(
	services: ComposeService[],
	configuredVersion: string
): ContainerFinding[] {
	if (!configuredVersion) return [];

	const owned = services.filter((service) => isOwlatOwnedImage(service.image));
	if (owned.length === 0) return [];

	const drifted = owned.filter((service) => service.imageTag !== configuredVersion);
	if (drifted.length === 0) {
		return [
			{
				ok: true,
				message: `all ${owned.length} Owlat container(s) run the configured version ${configuredVersion}`,
			},
		];
	}

	const findings: ContainerFinding[] = drifted.map((service) => ({
		ok: false,
		message:
			`container "${service.service}" runs ${service.imageTag || '(untagged)'} but ` +
			`OWLAT_VERSION is ${configuredVersion} — the configured and running versions have diverged`,
	}));
	findings.push({
		ok: false,
		message:
			`${drifted.length} of ${owned.length} Owlat container(s) were never recreated for ` +
			`${configuredVersion}. Run \`owlat start\` (docker compose up -d) to apply the configured version.`,
	});
	return findings;
}

/**
 * Read the CONFIGURED version (`OWLAT_VERSION`) out of a `.env` file's text.
 *
 * This must be read from the file at the moment it is asked for. Reading
 * `process.env.OWLAT_VERSION` inside a container answers a different question:
 * compose interpolates that value when the container is CREATED, so it reports
 * the version the container is RUNNING — exactly the half of the comparison
 * that cannot reveal drift.
 *
 * Returns `undefined` for anything outside a docker tag's charset, so a
 * hand-mangled line is never echoed back as if it were a version.
 */
export function parseConfiguredVersionFromEnv(envText: string): string | undefined {
	const match = envText.match(/^\s*OWLAT_VERSION\s*=\s*(.*?)\s*$/m);
	const raw = match?.[1]?.replace(/^["']|["']$/g, '').trim();
	if (!raw || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) return undefined;
	return raw;
}

/** True when any Owlat container runs a tag other than the configured version. */
export function hasVersionDrift(services: ComposeService[], configuredVersion: string): boolean {
	return evaluateVersionDrift(services, configuredVersion).some((finding) => !finding.ok);
}
