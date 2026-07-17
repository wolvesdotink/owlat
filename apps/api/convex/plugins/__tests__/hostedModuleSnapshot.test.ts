import { describe, expect, it, vi } from 'vitest';
import { snapshotHostedModule } from '../hostedModuleSnapshot';

const ERROR = 'Invalid hosted module';

describe('snapshotHostedModule', () => {
	it('copies required and present optional own function values', () => {
		const parseConfig = () => ({});
		const matches = () => true;
		const buildTriggerData = () => ({});
		const snapshot = snapshotHostedModule<Record<string, unknown>>(
			Object.freeze({ parseConfig, matches, buildTriggerData }),
			['parseConfig', 'matches'],
			['buildTriggerData'],
			ERROR
		);
		expect(snapshot).toEqual({ parseConfig, matches, buildTriggerData });
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	it('omits an optional field that is absent', () => {
		const snapshot = snapshotHostedModule<Record<string, unknown>>(
			Object.freeze({ parseConfig: () => ({}), matches: () => true }),
			['parseConfig', 'matches'],
			['buildTriggerData'],
			ERROR
		);
		expect('buildTriggerData' in snapshot).toBe(false);
	});

	it.each([['null', null] as const, ['array', [() => true]] as const, ['scalar', 42] as const])(
		'throws for a non-object module (%s)',
		(_label, value) => {
			expect(() => snapshotHostedModule(value, ['execute'], [], ERROR)).toThrow(ERROR);
		}
	);

	it('throws when a required field is missing', () => {
		expect(() =>
			snapshotHostedModule(
				Object.freeze({ parseConfig: () => ({}) }),
				['parseConfig', 'matches'],
				[],
				ERROR
			)
		).toThrow(ERROR);
	});

	it('throws when a required field is a non-function value', () => {
		expect(() =>
			snapshotHostedModule(Object.freeze({ execute: 'not-a-function' }), ['execute'], [], ERROR)
		).toThrow(ERROR);
	});

	it('rejects an accessor-based required field without invoking it', () => {
		const read = vi.fn(() => () => true);
		const value = Object.defineProperty({}, 'execute', { enumerable: true, get: read });
		expect(() => snapshotHostedModule(value, ['execute'], [], ERROR)).toThrow(ERROR);
		expect(read).not.toHaveBeenCalled();
	});

	it('drops an accessor-based optional field without invoking it', () => {
		const read = vi.fn(() => () => ({}));
		const value = Object.defineProperty({ matches: () => true }, 'buildTriggerData', {
			enumerable: true,
			get: read,
		});
		const snapshot = snapshotHostedModule<Record<string, unknown>>(
			value,
			['matches'],
			['buildTriggerData'],
			ERROR
		);
		expect('buildTriggerData' in snapshot).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});

	it('rejects a non-enumerable required function', () => {
		const value = Object.defineProperty({}, 'execute', {
			enumerable: false,
			value: () => true,
		});
		expect(() => snapshotHostedModule(value, ['execute'], [], ERROR)).toThrow(ERROR);
	});
});
