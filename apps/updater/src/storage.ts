/**
 * Disk space, the one resource a rollout consumes that nothing else in the
 * update path looked at.
 *
 * Every release pulls a full new set of images (web, mta, imap, mail-sync,
 * updater, clamav and a ~2 GB convex-deploy), and nothing ever removed the
 * previous set: `compose up` swaps the containers onto the new images and
 * leaves the old ones on disk. A self-hosted instance that updated roughly
 * daily carried twenty-odd releases, about 24 GB of images nothing referenced.
 * The day that filled the disk, `docker compose pull` died with
 * `no space left on device` and the operator was told only "Docker pull
 * failed". That is recoverable, because the pull runs before anything is
 * promoted, but it also comes back on every retry until someone gets a shell
 * on the host.
 *
 * The third-party images went the same way. A floating tag that `compose
 * pull` moved (Ollama publishes a new ~7 GB `latest` every few days) left the
 * old image behind untagged, and once Owlat's own images were pruned those
 * filled the same disk.
 *
 * So every rollout now starts by dropping the images no container uses, Owlat's
 * and the stack's third-party ones, then checks there is room for the new
 * release, and says in as many words when there is not.
 */
import { statfsSync } from 'node:fs';
import { hostname } from 'node:os';
import { exec, OWLAT_DIR } from './http.js';
import { ALLOWED_IMAGE_PREFIXES } from './security.js';

interface StorageStep {
	step: string;
	ok?: boolean;
	stdout: string;
	stderr: string;
}

/**
 * The free space a rollout is refused below.
 *
 * A release's images come to ~4.5 GB unpacked, and the base layers they share
 * with the running release are not pulled again. The image store also keeps
 * the compressed blobs while it unpacks them, though, so the bar sits at what a
 * pull can actually peak at, not at what the images add in the end.
 */
const MIN_FREE_BYTES_FOR_UPDATE = 4 * 1024 ** 3;

/**
 * The label that marks an image as one of ours. Every image the release
 * workflow publishes carries it (OCI `image.source`, set from the repository
 * that built it), so the release-image prune below cannot reach an operator's
 * own images or anything else sharing the Docker host.
 */
const SOURCE_LABEL = 'org.opencontainers.image.source';

/** What a label value may look like before it is handed to `--filter`. */
const SAFE_LABEL_VALUE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/;

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

const FREE_SPACE_REMEDIATION =
	'On the host: `docker image prune -a` removes every image no container uses, ' +
	'and `docker system df` shows what else is taking the space.';

/**
 * The repository this updater's own image was built from, read back off this
 * container. Deriving it rather than hard-coding it keeps a fork's updater
 * pruning the fork's images, and a dev build (no label) pruning nothing.
 */
function ownImageSource(): string | null {
	const result = exec(
		'docker',
		['inspect', hostname(), '--format', `{{index .Config.Labels "${SOURCE_LABEL}"}}`],
		OWLAT_DIR
	);
	const source = result.ok ? result.stdout.trim() : '';
	return SAFE_LABEL_VALUE.test(source) ? source : null;
}

/**
 * The third-party images the stack runs: every allowlisted image prefix except
 * our own published images and the two sidecars built on the host (removing
 * those would force a rebuild, not a pull).
 */
const THIRD_PARTY_IMAGE_PREFIXES = ALLOWED_IMAGE_PREFIXES.filter(
	(prefix) => !prefix.startsWith('ghcr.io/wolvesdotink/') && !prefix.startsWith('owlat-')
);

const reclaimedSpace = (stdout: string) =>
	stdout.match(/Total reclaimed space:\s*(.+)/)?.[1]?.trim() ?? '0B';

/**
 * Remove the images no container, running or stopped, references: Owlat's own
 * superseded releases and the third-party images a release left behind.
 *
 * Runs before the pull. By then the running stack pins exactly the images it
 * needs, so what goes is the releases before it, plus the current release's
 * one-shot convex-deploy image, which the next pull replaces anyway. Never
 * fatal: a prune that fails leaves the disk as it was, and the free-space check
 * that follows is what decides whether the rollout can go on.
 */
export function reclaimUnusedImages(): StorageStep {
	const results = [reclaimReleaseImages(), reclaimThirdPartyImages()];
	return {
		step: 'reclaim-images',
		ok: results.every((r) => r.ok),
		stdout: results
			.map((r) => r.stdout)
			.filter(Boolean)
			.join('\n'),
		stderr: results
			.map((r) => r.stderr)
			.filter(Boolean)
			.join('\n'),
	};
}

/** Every unused image carrying this updater's own source label. */
function reclaimReleaseImages(): Omit<StorageStep, 'step'> {
	const source = ownImageSource();
	if (!source) {
		return {
			ok: true,
			stdout:
				'Skipped release images: this updater image carries no source label, so there is no set of images it owns',
			stderr: '',
		};
	}

	const pruned = exec(
		'docker',
		['image', 'prune', '--all', '--force', '--filter', `label=${SOURCE_LABEL}=${source}`],
		OWLAT_DIR
	);
	return {
		ok: pruned.ok,
		stdout: pruned.ok
			? `Removed unused release images (reclaimed ${reclaimedSpace(pruned.stdout)})`
			: '',
		stderr: pruned.stderr,
	};
}

/**
 * The third-party images a release left behind, which the label prune above
 * cannot reach.
 *
 * Two shapes. A floating tag (`convex-backend:latest`, and `ollama:latest`
 * before it was pinned) that `compose pull` moved leaves the old image with no
 * name at all, so it is only reachable as a dangling image; one instance held
 * two superseded 7 GB Ollama images and three Convex backends that way, which
 * is what filled its disk. A pinned tag the release bumped leaves the old tag
 * behind, unused.
 *
 * Dangling images cannot be traced back to a repository, so that prune is not
 * scoped to the stack: it also takes an operator's own dangling images, which
 * nothing can start by name anyway. Tagged images are scoped to the stack's own
 * repositories, and `docker image rm` without `--force` refuses any image a
 * container still uses, so a refusal here is the expected answer for every
 * image the stack is running, not a failure.
 */
function reclaimThirdPartyImages(): Omit<StorageStep, 'step'> {
	const dangling = exec('docker', ['image', 'prune', '--force'], OWLAT_DIR);

	const listed = exec('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], OWLAT_DIR);
	const removed = (listed.ok ? listed.stdout.split('\n') : [])
		.map((ref) => ref.trim())
		.filter(
			(ref) =>
				ref &&
				!ref.endsWith(':<none>') &&
				THIRD_PARTY_IMAGE_PREFIXES.some((prefix) => ref.startsWith(prefix))
		)
		.filter((ref) => exec('docker', ['image', 'rm', ref], OWLAT_DIR).ok);

	const stdout = [
		dangling.ok ? `Removed superseded images (reclaimed ${reclaimedSpace(dangling.stdout)})` : '',
		removed.length ? `Removed unused third-party images: ${removed.join(', ')}` : '',
	];
	return {
		ok: dangling.ok && listed.ok,
		stdout: stdout.filter(Boolean).join('\n'),
		stderr: [dangling.stderr, listed.stderr].filter(Boolean).join('\n'),
	};
}

/**
 * Bytes free on the filesystem that holds the install directory, or null
 * when it cannot be read.
 *
 * Docker's image store lives on the host (`/var/lib/docker`,
 * `/var/lib/containerd`), which this container cannot see. The install
 * directory is bind-mounted in from the same host, and on a default install
 * (one root filesystem) it sits on the same disk. An install that moved
 * Docker's data root to another volume gets a check on the wrong disk, and the
 * pull-failure message below is the fallback for that case.
 */
function freeBytes(): number | null {
	try {
		const stats = statfsSync(OWLAT_DIR);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

/** Refuse to pull a release the disk has no room for. */
export function diskSpacePreflight(minFree = MIN_FREE_BYTES_FOR_UPDATE): StorageStep {
	const step = 'disk-space-preflight';
	const free = freeBytes();
	if (free === null) {
		return {
			step,
			ok: true,
			stdout: 'Free disk space could not be read — not checked',
			stderr: '',
		};
	}
	if (free >= minFree) {
		return { step, ok: true, stdout: `${gib(free)} free on the host disk`, stderr: '' };
	}
	return {
		step,
		ok: false,
		stdout: '',
		stderr:
			`Not enough disk space to update: ${gib(free)} free on the host, and pulling a release ` +
			`needs at least ${gib(minFree)}. Nothing was changed. ${FREE_SPACE_REMEDIATION}`,
	};
}

/**
 * The operator-facing reason for a failed `docker compose pull`.
 *
 * The pull's stderr is hundreds of lines of per-layer progress with the actual
 * error last, and the message is the only part of it the dashboard shows. The
 * full output stays in the step list.
 */
export function pullFailureMessage(stderr: string): string {
	if (/no space left on device/i.test(stderr)) {
		return (
			'Docker pull failed: the host disk is full. The update was aborted and nothing changed. ' +
			FREE_SPACE_REMEDIATION
		);
	}
	const lastLine = stderr
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.pop();
	const reason = lastLine && lastLine.length > 300 ? `${lastLine.slice(0, 300)}…` : lastLine;
	return reason
		? `Docker pull failed (${reason}). The update was aborted and nothing changed.`
		: 'Docker pull failed. The update was aborted and nothing changed.';
}
