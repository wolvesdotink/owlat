/**
 * The two image lists. `.github/docker-images.json` is what CI builds: each
 * entry names the workspace package and Dockerfile its selection matches on,
 * and keeps the rest (build context, smoke flags) for the build matrix it is
 * written back out to. `docker/images.json` is what a release publishes; the
 * release notes list its names and alias promotion reads which images the root
 * compose file pins.
 */
import { readFileSync } from 'node:fs';
import { arrayOf, decodeJson, object, optional, string } from '../json';
import type { DockerImage } from './selection';

const decodeBuildImages = arrayOf(object({ name: string, package: string, dockerfile: string }));

/** The CI build list at `path`, every entry's other fields kept. */
export function readDockerImages(path: string): DockerImage[] {
	return decodeJson(readFileSync(path, 'utf8'), decodeBuildImages, path);
}

const decodePublishedImages = arrayOf(object({ name: string, rootCompose: optional(string) }));

type PublishedImage = ReturnType<typeof decodePublishedImages>[number];

/** A release's published image list (`docker/images.json` at its tag). */
export function parsePublishedImages(text: string, label: string): PublishedImage[] {
	return decodeJson(text, decodePublishedImages, label);
}
