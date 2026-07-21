/**
 * Durable, secret-free checkpoints for the quickstart provisioning pipeline.
 *
 * The file stores only a hash of public run inputs and completed step names.
 * Credentials, environment values, and admin passwords are deliberately never
 * persisted. Writes use an adjacent temporary file + rename so interruption
 * cannot leave a half-written checkpoint that prevents the next run.
 */

import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STATE_FILE = '.owlat-provisioning.json';
const STATE_VERSION = 1;

export type ProvisioningStep =
	| 'compose-up'
	| 'convex-ready'
	| 'admin-key'
	| 'deploy-functions'
	| 'runtime-env'
	| 'routes-ready'
	| 'bootstrap-admin'
	| 'seed-demo';

interface StepState {
	status: 'completed';
	completedAt: number;
}

interface CheckpointState {
	version: typeof STATE_VERSION;
	fingerprint: string;
	steps: Partial<Record<ProvisioningStep, StepState>>;
	updatedAt: number;
}

export interface CheckpointInputs {
	mode: string;
	shouldBootstrap: boolean;
	shouldSeed: boolean;
	adminEmail?: string;
	version?: string;
	buildLocal: boolean;
	localImages: boolean;
	composeProfiles: string[];
	sourceRevision?: string;
	network?: {
		siteUrl: string;
		convexUrl: string;
		convexSiteUrl: string;
	};
	sending?: {
		provider: string;
		domain?: string;
	};
}

function fingerprint(inputs: CheckpointInputs): string {
	return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

function isCheckpointState(value: unknown): value is CheckpointState {
	if (typeof value !== 'object' || value === null) return false;
	const state = value as Partial<CheckpointState>;
	return (
		state.version === STATE_VERSION &&
		typeof state.fingerprint === 'string' &&
		typeof state.steps === 'object' &&
		state.steps !== null &&
		typeof state.updatedAt === 'number'
	);
}

export class ProvisioningCheckpoint {
	private constructor(
		private readonly path: string,
		private readonly state: CheckpointState
	) {}

	static async open(args: {
		owlatDir: string;
		inputs: CheckpointInputs;
		restart?: boolean;
	}): Promise<ProvisioningCheckpoint> {
		const path = join(args.owlatDir, STATE_FILE);
		const expectedFingerprint = fingerprint(args.inputs);
		let existing: CheckpointState | null = null;

		if (!args.restart) {
			try {
				const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
				if (isCheckpointState(parsed) && parsed.fingerprint === expectedFingerprint) {
					existing = parsed;
				}
			} catch {
				// Missing, truncated, or obsolete state starts a clean run.
			}
		} else {
			await unlink(path).catch(() => undefined);
		}

		const state =
			existing ??
			({
				version: STATE_VERSION,
				fingerprint: expectedFingerprint,
				steps: {},
				updatedAt: Date.now(),
			} satisfies CheckpointState);
		const checkpoint = new ProvisioningCheckpoint(path, state);
		if (!existing) await checkpoint.persist();
		return checkpoint;
	}

	isComplete(step: ProvisioningStep): boolean {
		return this.state.steps[step]?.status === 'completed';
	}

	completedSteps(): ProvisioningStep[] {
		return Object.entries(this.state.steps)
			.filter(([, value]) => value?.status === 'completed')
			.map(([step]) => step as ProvisioningStep);
	}

	async complete(step: ProvisioningStep): Promise<void> {
		this.state.steps[step] = { status: 'completed', completedAt: Date.now() };
		this.state.updatedAt = Date.now();
		await this.persist();
	}

	private async persist(): Promise<void> {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, {
			encoding: 'utf-8',
			mode: 0o600,
		});
		await rename(tempPath, this.path);
	}
}
