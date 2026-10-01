/**
 * The images a local-push install builds on THIS machine and streams to the
 * server: every first-party service docker-compose.yml can build
 * ({@link COMPOSE_BUILD_SERVICES}), plus the setup-cli image quickstart runs in.
 *
 * Every one of them, not only those the chosen features start. Their `dev` tag
 * is never published, so an image the server lacks can be neither pulled nor
 * built there (the server this mode is for is too small to build), and a
 * feature switched on after the install starts a service a narrower list
 * would have left out.
 */
import type { LocalBuild } from '@owlat/desktop/src/ssh';
import { COMPOSE_BUILD_SERVICES } from '@owlat/shared/composeBuildServices';
import { LOCAL_SETUP_IMAGE, LOCAL_VERSION_TAG } from './provisioningCommands';

/** Every image a local-push install puts on the server, under the `dev` tag. */
export const DEV_IMAGES: readonly string[] = [
	...COMPOSE_BUILD_SERVICES.map((s) => `${s.image}:${LOCAL_VERSION_TAG}`),
	LOCAL_SETUP_IMAGE,
];

/**
 * The local stack build (push-images mode), targeting the server's platform.
 * This names only what to build; the desktop runs it as
 * `docker compose --profile … build <services>` in the checkout, under the
 * `dev` tag, and owns every other part of that invocation. Every profile of
 * the listed services is enabled so Compose treats each of them as active.
 */
export function localStackBuild(platform: string): LocalBuild {
	const profiles = new Set(COMPOSE_BUILD_SERVICES.flatMap((s) => s.profiles));
	return {
		kind: 'stack',
		platform,
		profiles: [...profiles].sort(),
		services: COMPOSE_BUILD_SERVICES.map((s) => s.service),
	};
}

/**
 * Check on the server that every pushed image arrived: prints `missing=<image>`
 * for each one `docker load` did not leave behind, so the wizard stops before
 * the installer would try to pull a `dev` tag that does not exist.
 */
export function verifyImagesCommand(images: readonly string[]): string {
	const list = images.map((i) => `'${i}'`).join(' ');
	return `for i in ${list}; do docker image inspect "$i" >/dev/null 2>&1 || echo "missing=$i"; done`;
}

/** The images a {@link verifyImagesCommand} run reported missing. */
export function parseMissingImages(lines: readonly string[]): string[] {
	return lines.flatMap((l) => {
		const m = l.trim().match(/^missing=(\S+)$/);
		return m?.[1] ? [m[1]] : [];
	});
}
