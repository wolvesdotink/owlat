import type { StepModule, StepOutcome } from '../../types';

export interface DelayStepConfig {
	duration: number;
	unit: 'minutes' | 'hours' | 'days' | 'weeks';
}

const VALID_UNITS = new Set(['minutes', 'hours', 'days', 'weeks']);

export function delayConfigToMs(config: DelayStepConfig): number {
	const { duration, unit } = config;
	switch (unit) {
		case 'minutes':
			return duration * 60 * 1000;
		case 'hours':
			return duration * 60 * 60 * 1000;
		case 'days':
			return duration * 24 * 60 * 60 * 1000;
		case 'weeks':
			return duration * 7 * 24 * 60 * 60 * 1000;
	}
}

export const delayStepModule: StepModule<'delay', DelayStepConfig> = {
	kind: 'delay',
	parseConfig(raw) {
		if (!raw || typeof raw !== 'object') {
			throw new Error('delay step: config must be an object');
		}
		const r = raw as Record<string, unknown>;
		if (typeof r['duration'] !== 'number' || r['duration'] <= 0) {
			throw new Error('delay step: duration must be a positive number');
		}
		if (typeof r['unit'] !== 'string' || !VALID_UNITS.has(r['unit'])) {
			throw new Error(`delay step: invalid unit "${r['unit'] as string}"`);
		}
		return {
			duration: r['duration'],
			unit: r['unit'] as DelayStepConfig['unit'],
		};
	},
	entryDelay(config) {
		return delayConfigToMs(config);
	},
	async execute(): Promise<StepOutcome> {
		// Delay steps require no action at execution time — the walker schedules
		// the next step using this module's `entryDelay`. By the time `execute`
		// is called the delay has already elapsed.
		return { status: 'completed' };
	},
};
