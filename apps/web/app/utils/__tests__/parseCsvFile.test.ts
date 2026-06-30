import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('papaparse', () => ({
	default: {
		parse: vi.fn(),
		unparse: vi.fn(),
	},
}));

import Papa from 'papaparse';
import { parseCsvFile } from '../contactsCsv';

type PapaMock = {
	mockImplementation: (
		fn: (
			_file: unknown,
			options: {
				complete: (result: { data: string[][]; errors: Array<{ message: string }> }) => void;
				error: (error: unknown) => void;
			},
		) => void,
	) => void;
};

function mockComplete(data: string[][], errors: Array<{ message: string }> = []) {
	(Papa.parse as unknown as PapaMock).mockImplementation((_file, options) => {
		options.complete({ data, errors });
	});
}

function mockError(error: unknown) {
	(Papa.parse as unknown as PapaMock).mockImplementation((_file, options) => {
		options.error(error);
	});
}

const file = () => new File([''], 'test.csv', { type: 'text/csv' });

describe('parseCsvFile', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('resolves with the parsed rows', async () => {
		mockComplete([
			['Email', 'Name'],
			['a@b.com', 'Alice'],
		]);
		await expect(parseCsvFile(file())).resolves.toEqual([
			['Email', 'Name'],
			['a@b.com', 'Alice'],
		]);
	});

	it('drops fully blank rows (all cells whitespace/empty)', async () => {
		mockComplete([
			['Email'],
			['', ''],
			['  ', '\t'],
			['a@b.com'],
		]);
		await expect(parseCsvFile(file())).resolves.toEqual([['Email'], ['a@b.com']]);
	});

	it('keeps rows with at least one non-blank cell', async () => {
		mockComplete([['', 'x'], ['  ', '']]);
		await expect(parseCsvFile(file())).resolves.toEqual([['', 'x']]);
	});

	it('rejects with the first Papa parse error message', async () => {
		mockComplete([['Email'], ['a@b.com']], [{ message: 'Unexpected quote' }]);
		await expect(parseCsvFile(file())).rejects.toThrow('Unexpected quote');
	});

	it('rejects when the error callback fires (Error instance preserved)', async () => {
		mockError(new Error('File read error'));
		await expect(parseCsvFile(file())).rejects.toThrow('File read error');
	});

	it('extracts the message from a plain { message } error callback', async () => {
		mockError({ message: 'weird' });
		await expect(parseCsvFile(file())).rejects.toThrow('weird');
	});

	it('stringifies a non-Error, non-object error callback', async () => {
		mockError('boom');
		await expect(parseCsvFile(file())).rejects.toThrow('boom');
	});
});
