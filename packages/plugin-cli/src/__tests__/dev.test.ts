import { describe, expect, it } from 'vitest';
import { createChangeSignal } from '../changeSignal';
import { runDev } from '../commands/dev';
import { PluginCliError } from '../errors';
import { captureIo } from './fixtures';

describe('createChangeSignal', () => {
	it('delivers a pending notify to the next consumer', async () => {
		const signal = createChangeSignal();
		signal.notify();
		const iterator = signal.events[Symbol.asyncIterator]();
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: false });
	});

	it('coalesces multiple notifies that arrive before consumption into one', async () => {
		const signal = createChangeSignal();
		signal.notify();
		signal.notify();
		signal.notify();
		const iterator = signal.events[Symbol.asyncIterator]();
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: false });
		signal.close();
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
	});

	it('resolves a waiting consumer when closed', async () => {
		const signal = createChangeSignal();
		const iterator = signal.events[Symbol.asyncIterator]();
		const pending = iterator.next();
		signal.close();
		await expect(pending).resolves.toEqual({ value: undefined, done: true });
	});
});

describe('runDev', () => {
	it('regenerates once initially and once per change event', async () => {
		const { io } = captureIo();
		let runs = 0;
		async function* events(): AsyncGenerator<void> {
			yield;
			yield;
		}

		await runDev('/workspace', {
			events: events(),
			io,
			runCodegen: async () => {
				runs += 1;
			},
		});

		expect(runs).toBe(3);
	});

	it('keeps running after a codegen failure and reports it', async () => {
		const { io, errors } = captureIo();
		let runs = 0;
		async function* events(): AsyncGenerator<void> {
			yield;
		}

		await runDev('/workspace', {
			events: events(),
			io,
			runCodegen: async () => {
				runs += 1;
				if (runs === 1) throw new PluginCliError('bad manifest', ['fix it']);
			},
		});

		expect(runs).toBe(2);
		expect(errors.join('\n')).toContain('bad manifest');
		expect(errors.join('\n')).toContain('fix it');
	});
});
