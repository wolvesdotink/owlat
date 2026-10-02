/**
 * The first-party services the root docker-compose.yml can build: the ones
 * with a `build:` section, each with its image (without the tag; Compose tags
 * every one `${OWLAT_VERSION:-dev}`) and its profiles.
 *
 * The desktop wizard's local-push install builds and pushes exactly these
 * (apps/web/app/lib/desktop/provisioningImages.ts). Its hand-written list once
 * fell behind Compose and left services without an image on the server, so
 * scripts/__tests__/desktop-local-push-images.test.ts compares this table with
 * docker-compose.yml and docker/images.json: a buildable service added to
 * Compose fails that test until it is listed here.
 */

export interface ComposeBuildService {
	/** The Compose service, as `docker compose build` names it. */
	readonly service: string;
	/** Its `image:` without the tag. */
	readonly image: string;
	/** Its Compose profiles; empty when the service always runs. */
	readonly profiles: readonly string[];
}

const CODE_TASK_PROFILES = ['inbox-codetasks', 'plugin-tasks', 'dev'] as const;

export const COMPOSE_BUILD_SERVICES: readonly ComposeBuildService[] = [
	{ service: 'web', image: 'ghcr.io/wolvesdotink/web', profiles: [] },
	{ service: 'mta', image: 'ghcr.io/wolvesdotink/mta', profiles: ['mta'] },
	{ service: 'dns-resolver', image: 'ghcr.io/wolvesdotink/unbound', profiles: ['mta'] },
	{ service: 'clamav', image: 'ghcr.io/wolvesdotink/clamav', profiles: ['clamav'] },
	{ service: 'updater', image: 'ghcr.io/wolvesdotink/updater', profiles: [] },
	{ service: 'convex-deploy', image: 'ghcr.io/wolvesdotink/convex-deploy', profiles: ['deploy'] },
	{ service: 'code-worker', image: 'owlat-code-worker', profiles: CODE_TASK_PROFILES },
	{ service: 'convex-fn-proxy', image: 'owlat-convex-fn-proxy', profiles: CODE_TASK_PROFILES },
	{
		service: 'code-worker-egress',
		image: 'ghcr.io/wolvesdotink/tinyproxy',
		profiles: CODE_TASK_PROFILES,
	},
	{ service: 'imap', image: 'ghcr.io/wolvesdotink/imap', profiles: ['personal-mail'] },
	{ service: 'mail-sync', image: 'ghcr.io/wolvesdotink/mail-sync', profiles: ['external-mail'] },
	{
		service: 'decision-local',
		image: 'ghcr.io/wolvesdotink/decision-local',
		profiles: ['decision-local'],
	},
];
