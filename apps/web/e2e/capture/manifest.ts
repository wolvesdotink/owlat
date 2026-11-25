/**
 * The pair manifest (`capture.json`): the settings and `--path` steps the first
 * run in an output directory records and every later run reuses, so the two
 * labels of a pair can only differ by the change. Pure, so the rules are unit
 * tested.
 */

import { isAppLocale, type AppLocale } from '@owlat/shared/appLocales';
import {
	ACCOUNTS,
	CaptureUsageError,
	type Account,
	type CaptureRequest,
	type CaptureStep,
	type PlannedShot,
	type Theme,
	type Viewport,
} from './options';

/**
 * The presentation every capture in one output directory shares. The first
 * run records it; later runs reuse it, so "before" and "after" have the same
 * viewport, theme, language and account, see the same clock (relative times
 * such as "5m ago" would otherwise differ between the two), and take the same
 * steps before each `--path` shot.
 */
export interface CaptureManifest {
	readonly version: 2;
	/** ISO time the app's clock starts at in every run of the pair. */
	readonly clock: string;
	readonly theme: Theme;
	readonly viewport: Viewport;
	readonly fullPage: boolean;
	readonly locale: AppLocale;
	readonly account: Account;
	/** Each `--path` shot captured so far: its route and its steps. */
	readonly shots: Readonly<Record<string, RecordedPathShot>>;
}

export interface RecordedPathShot {
	readonly path: string;
	readonly steps: readonly CaptureStep[];
}

export const MANIFEST_FILE = 'capture.json';
export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };

function isStep(value: unknown): value is CaptureStep {
	const step = value as Record<string, unknown> | null;
	switch (step?.['action']) {
		case 'click':
		case 'wait-for':
			return typeof step['target'] === 'string';
		case 'fill':
			return typeof step['target'] === 'string' && typeof step['value'] === 'string';
		case 'press':
			return typeof step['key'] === 'string';
		default:
			return false;
	}
}

function isRecordedShots(value: unknown): value is Record<string, RecordedPathShot> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((shot) => {
		const recorded = shot as Partial<RecordedPathShot> | null;
		return (
			typeof recorded?.path === 'string' &&
			Array.isArray(recorded.steps) &&
			recorded.steps.every(isStep)
		);
	});
}

export function parseManifest(raw: string, file: string): CaptureManifest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new CaptureUsageError(`${file} is not valid JSON; delete it to start a new pair.`);
	}
	const manifest = value as Record<string, unknown> | null;
	const viewport = manifest?.['viewport'] as Partial<Viewport> | undefined;
	const version = manifest?.['version'];
	const common =
		typeof manifest?.['clock'] === 'string' &&
		!Number.isNaN(Date.parse(manifest['clock'])) &&
		(manifest['theme'] === 'light' || manifest['theme'] === 'dark') &&
		typeof viewport?.width === 'number' &&
		typeof viewport.height === 'number' &&
		typeof manifest['fullPage'] === 'boolean';
	// A version 1 pair was always taken in English, as the seeded owner, with
	// no steps: those are the defaults it is read with.
	if (common && version === 1) {
		const { clock, theme, fullPage } = manifest as unknown as CaptureManifest;
		return {
			version: 2,
			clock,
			theme,
			viewport: { width: viewport.width!, height: viewport.height! },
			fullPage,
			locale: 'en',
			account: 'owner',
			shots: {},
		};
	}
	if (
		!common ||
		version !== 2 ||
		!isAppLocale(manifest['locale']) ||
		!(ACCOUNTS as readonly unknown[]).includes(manifest['account']) ||
		!isRecordedShots(manifest['shots'])
	) {
		throw new CaptureUsageError(
			`${file} is not a capture manifest; delete it to start a new pair.`
		);
	}
	return manifest as unknown as CaptureManifest;
}

function refuseConflicts(conflicts: readonly string[]): void {
	if (conflicts.length > 0) {
		throw new CaptureUsageError(
			`This directory already holds a pair captured differently: ${conflicts.join(', ')}. ` +
				'Drop the flag, or use a new --out for a new pair.'
		);
	}
}

/**
 * The manifest for this run: the recorded one, or a new one from the flags.
 * A flag that disagrees with the recorded pair is refused instead of silently
 * producing a capture that does not match its partner.
 */
export function settleManifest(
	recorded: CaptureManifest | null,
	request: Pick<CaptureRequest, 'theme' | 'viewport' | 'fullPage' | 'locale' | 'account'>,
	now: Date
): { manifest: CaptureManifest; created: boolean } {
	if (!recorded) {
		return {
			manifest: {
				version: 2,
				clock: now.toISOString(),
				theme: request.theme ?? 'light',
				viewport: request.viewport ?? DEFAULT_VIEWPORT,
				fullPage: request.fullPage,
				locale: request.locale ?? 'en',
				account: request.account ?? 'owner',
				shots: {},
			},
			created: true,
		};
	}
	const conflicts: string[] = [];
	if (request.theme !== undefined && request.theme !== recorded.theme) {
		conflicts.push(`--theme ${request.theme} (recorded: ${recorded.theme})`);
	}
	const viewport = request.viewport;
	if (
		viewport !== undefined &&
		(viewport.width !== recorded.viewport.width || viewport.height !== recorded.viewport.height)
	) {
		conflicts.push(
			`--viewport ${viewport.width}x${viewport.height} (recorded: ${recorded.viewport.width}x${recorded.viewport.height})`
		);
	}
	if (request.fullPage && !recorded.fullPage) {
		conflicts.push('--full-page (recorded: viewport only)');
	}
	if (request.locale !== undefined && request.locale !== recorded.locale) {
		conflicts.push(`--locale ${request.locale} (recorded: ${recorded.locale})`);
	}
	if (request.account !== undefined && request.account !== recorded.account) {
		const flag = request.account === 'signed-out' ? '--signed-out' : `--as ${request.account}`;
		conflicts.push(`${flag} (recorded: ${recorded.account})`);
	}
	refuseConflicts(conflicts);
	return { manifest: recorded, created: false };
}

function describeSteps(steps: readonly CaptureStep[]): string {
	return steps.length === 0 ? 'no steps' : steps.map((step) => step.action).join(', ');
}

function sameSteps(a: readonly CaptureStep[], b: readonly CaptureStep[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The planned shots checked against the pair. A `--path` shot the pair
 * already holds takes the recorded steps when the run gives none, and is
 * refused when its route or steps differ; a new one is added to the record.
 * Named surfaces find their controls by English text and need a signed-in
 * account, so they are refused for a German or a signed-out pair.
 */
export function settleShots(
	manifest: CaptureManifest,
	shots: readonly PlannedShot[]
): { manifest: CaptureManifest; shots: PlannedShot[]; changed: boolean } {
	const surfaces = shots.filter((shot) => shot.path === undefined).map((shot) => shot.name);
	if (surfaces.length > 0 && (manifest.locale !== 'en' || manifest.account === 'signed-out')) {
		const why =
			manifest.account === 'signed-out'
				? 'they need a signed-in account'
				: 'they find their controls by English text';
		throw new CaptureUsageError(
			`The surface ${surfaces.join(', ')} cannot be captured ` +
				`${manifest.account === 'signed-out' ? 'signed out' : `in ${manifest.locale}`}: ${why}. ` +
				'Capture the route with --path instead.'
		);
	}
	const recordedShots: Record<string, RecordedPathShot> = { ...manifest.shots };
	const conflicts: string[] = [];
	let changed = false;
	const settled = shots.map((shot) => {
		if (shot.path === undefined) return shot;
		const steps = shot.steps ?? [];
		const recorded = recordedShots[shot.name];
		if (!recorded) {
			recordedShots[shot.name] = { path: shot.path, steps };
			changed = true;
			return { ...shot, steps };
		}
		if (recorded.path !== shot.path) {
			conflicts.push(`${shot.name} at ${shot.path} (recorded: ${recorded.path})`);
		} else if (steps.length > 0 && !sameSteps(steps, recorded.steps)) {
			conflicts.push(
				`${shot.name} with ${describeSteps(steps)} (recorded: ${describeSteps(recorded.steps)})`
			);
		}
		return { ...shot, steps: recorded.steps };
	});
	refuseConflicts(conflicts);
	return {
		manifest: changed ? { ...manifest, shots: recordedShots } : manifest,
		shots: settled,
		changed,
	};
}
