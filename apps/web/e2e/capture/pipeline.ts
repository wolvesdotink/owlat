/**
 * The order of one capture run, with the browser and the filesystem passed in
 * so the guarantees are tested without either: everything that can be refused
 * is refused before the browser starts, and nothing is written unless every
 * requested shot was captured. A run that fails halfway therefore leaves no
 * PNG behind that could be mistaken for evidence (a login screen, a page
 * still loading), and no half-written pair.
 */

import { join } from 'node:path';
import {
	MANIFEST_FILE,
	parseManifest,
	planShots,
	settleManifest,
	type CaptureManifest,
	type CaptureRequest,
	type PlannedShot,
} from './options';

export interface CaptureIO {
	exists(file: string): boolean;
	readText(file: string): string;
	/** Creates the directory and writes every file; called at most once per run. */
	writeAll(dir: string, files: ReadonlyArray<{ file: string; data: string | Uint8Array }>): void;
	now(): Date;
}

/** Captures every planned shot, in order, or throws. */
export type Shooter = (
	shots: readonly PlannedShot[],
	manifest: CaptureManifest
) => Promise<Uint8Array[]>;

export interface CaptureResult {
	readonly files: readonly string[];
	readonly manifest: CaptureManifest;
	readonly manifestCreated: boolean;
}

export async function runCapture(
	request: CaptureRequest,
	outDir: string,
	knownSurfaces: readonly string[],
	shoot: Shooter,
	io: CaptureIO
): Promise<CaptureResult> {
	const manifestFile = join(outDir, MANIFEST_FILE);
	const recorded = io.exists(manifestFile)
		? parseManifest(io.readText(manifestFile), manifestFile)
		: null;
	const { manifest, created } = settleManifest(recorded, request, io.now());
	const shots = planShots(request, outDir, knownSurfaces, (file) => io.exists(file));
	const images = await shoot(shots, manifest);
	if (images.length !== shots.length) {
		throw new Error(`Expected ${shots.length} captures, got ${images.length}.`);
	}
	io.writeAll(outDir, [
		...(created ? [{ file: manifestFile, data: `${JSON.stringify(manifest, null, '\t')}\n` }] : []),
		...shots.map((shot, index) => ({ file: shot.file, data: images[index]! })),
	]);
	return { files: shots.map((shot) => shot.file), manifest, manifestCreated: created };
}
