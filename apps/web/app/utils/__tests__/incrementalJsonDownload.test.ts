import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import { writeAccountJsonExport } from '../accountJsonExport';
import {
	jsonArray,
	jsonObject,
	jsonValue,
	type JsonValueWriter,
	type TextChunkSink,
} from '../incrementalJsonSerializer';
import {
	jsonObjectWithStreamedProperties,
	isSaveFilePickerCancellation,
	openIncrementalJsonDownload,
	revokeObjectUrlAfterDownloadNavigation,
	writeJsonDownload,
} from '../incrementalJsonDownload';

function createRecordingSink() {
	const chunks: string[] = [];
	const sink: TextChunkSink = {
		write: vi.fn(async (chunk: string) => {
			chunks.push(chunk);
		}),
		close: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined),
	};
	return { chunks, sink };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('incremental JSON downloads', () => {
	it('does not classify an arbitrary AbortError as a save-picker cancellation', () => {
		const cancellation = new Error('The user aborted a request');
		cancellation.name = 'AbortError';

		expect(isSaveFilePickerCancellation(cancellation)).toBe(false);
		expect(isSaveFilePickerCancellation(new Error('disk full'))).toBe(false);
		expect(isSaveFilePickerCancellation(null)).toBe(false);
	});

	it('marks only an AbortError thrown by the save picker as a neutral cancellation', async () => {
		const cancellation = new Error('The user closed the picker');
		cancellation.name = 'AbortError';
		vi.stubGlobal('window', {
			showSaveFilePicker: vi.fn(async () => {
				throw cancellation;
			}),
		});

		let caught: unknown;
		try {
			await openIncrementalJsonDownload('account-export.json');
		} catch (error) {
			caught = error;
		}

		expect(isSaveFilePickerCancellation(caught)).toBe(true);
	});

	it('does not mark a later AbortError from the destination stream as picker cancellation', async () => {
		const streamFailure = new Error('The destination stream aborted');
		streamFailure.name = 'AbortError';
		const abort = vi.fn(async () => undefined);
		vi.stubGlobal('window', {
			showSaveFilePicker: vi.fn(async () => ({
				createWritable: vi.fn(async () => ({
					write: vi.fn(async () => {
						throw streamFailure;
					}),
					close: vi.fn(async () => undefined),
					abort,
				})),
			})),
		});
		const sink = await openIncrementalJsonDownload('account-export.json');

		let caught: unknown;
		try {
			await writeJsonDownload(sink, jsonValue({ exported: true }));
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(streamFailure);
		expect(isSaveFilePickerCancellation(caught)).toBe(false);
		expect(abort).toHaveBeenCalledWith(streamFailure);
	});

	it('defers object URL revocation until after the download navigation task', () => {
		vi.useFakeTimers();
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { revokeObjectURL });

		revokeObjectUrlAfterDownloadNavigation('blob:account-export');

		expect(revokeObjectURL).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:account-export');
		vi.useRealTimers();
	});

	it('removes the OPFS temporary file when writable creation fails', async () => {
		const failure = new Error('OPFS quota exceeded');
		const removeEntry = vi.fn(async () => undefined);
		const createWritable = vi.fn(async () => {
			throw failure;
		});
		let createdTemporaryName = '';
		const getFileHandle = vi.fn(async (name: string) => {
			createdTemporaryName = name;
			return { createWritable };
		});
		vi.stubGlobal('navigator', {
			storage: {
				getDirectory: vi.fn(async () => ({ getFileHandle, removeEntry })),
			},
		});

		await expect(openIncrementalJsonDownload('account-export.json')).rejects.toBe(failure);

		expect(getFileHandle).toHaveBeenCalledWith(expect.stringMatching(/^\.owlat-account-export-/), {
			create: true,
		});
		expect(removeEntry).toHaveBeenCalledWith(createdTemporaryName);
	});

	it('removes old OPFS export files but leaves recent and unrelated files alone', async () => {
		const staleName = '.owlat-account-export-stale.json';
		const recentName = '.owlat-account-export-recent.json';
		const unrelatedName = 'other-file.json';
		const createWritable = vi.fn(async () => ({
			write: vi.fn(async () => undefined),
			close: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
		}));
		const currentHandle = { createWritable };
		const entries = vi.fn(async function* () {
			yield [
				staleName,
				{
					kind: 'file',
					getFile: vi.fn(async () => ({ lastModified: Date.now() - 25 * 60 * 60 * 1000 })),
				},
			] as const;
			yield [
				recentName,
				{
					kind: 'file',
					getFile: vi.fn(async () => ({ lastModified: Date.now() })),
				},
			] as const;
			yield [
				unrelatedName,
				{
					kind: 'file',
					getFile: vi.fn(async () => ({ lastModified: 0 })),
				},
			] as const;
		});
		const removeEntry = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', {
			storage: {
				getDirectory: vi.fn(async () => ({
					entries,
					getFileHandle: vi.fn(async () => currentHandle),
					removeEntry,
				})),
			},
		});

		await openIncrementalJsonDownload('account-export.json');

		expect(removeEntry).toHaveBeenCalledWith(staleName);
		expect(removeEntry).not.toHaveBeenCalledWith(recentName);
		expect(removeEntry).not.toHaveBeenCalledWith(unrelatedName);
	});

	it('bounds an error-tolerant OPFS stale-export sweep', async () => {
		let visitedEntries = 0;
		const entries = vi.fn(async function* () {
			for (let index = 0; index < 100; index += 1) {
				visitedEntries += 1;
				yield [
					`.owlat-account-export-stale-${index}.json`,
					{
						kind: 'file',
						getFile: vi.fn(async () => ({ lastModified: 0 })),
					},
				] as const;
			}
		});
		const removeEntry = vi.fn(async () => {
			throw new Error('concurrent cleanup');
		});
		vi.stubGlobal('navigator', {
			storage: {
				getDirectory: vi.fn(async () => ({
					entries,
					getFileHandle: vi.fn(async () => ({
						createWritable: vi.fn(async () => ({
							write: vi.fn(async () => undefined),
							close: vi.fn(async () => undefined),
							abort: vi.fn(async () => undefined),
						})),
					})),
					removeEntry,
				})),
			},
		});

		await expect(openIncrementalJsonDownload('account-export.json')).resolves.toBeDefined();

		expect(visitedEntries).toBeLessThanOrEqual(64);
		expect(removeEntry).toHaveBeenCalledTimes(16);
	});

	it('continues opening the export when OPFS inspection or enumeration fails', async () => {
		const entries = vi.fn(async function* () {
			yield [
				'.owlat-account-export-unreadable.json',
				{
					kind: 'file',
					getFile: vi.fn(async () => {
						throw new Error('file disappeared');
					}),
				},
			] as const;
			throw new Error('directory enumeration failed');
		});
		const createWritable = vi.fn(async () => ({
			write: vi.fn(async () => undefined),
			close: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
		}));
		vi.stubGlobal('navigator', {
			storage: {
				getDirectory: vi.fn(async () => ({
					entries,
					getFileHandle: vi.fn(async () => ({ createWritable })),
					removeEntry: vi.fn(async () => undefined),
				})),
			},
		});

		await expect(openIncrementalJsonDownload('account-export.json')).resolves.toBeDefined();
		expect(createWritable).toHaveBeenCalledOnce();
	});

	it('writes a large export incrementally without constructing one export-sized chunk', async () => {
		const rowCount = 50_000;
		let generatedRows = 0;
		async function* rows(): AsyncGenerator<JsonValueWriter> {
			for (let index = 0; index < rowCount; index += 1) {
				generatedRows += 1;
				yield jsonValue({ index, value: `row-${index}` });
			}
		}
		const { chunks, sink } = createRecordingSink();

		await writeJsonDownload(
			sink,
			jsonObject([
				['exportedAt', jsonValue('2026-07-26T12:00:00.000Z')],
				['rows', jsonArray(rows())],
			])
		);

		expect(generatedRows).toBe(rowCount);
		expect(sink.close).toHaveBeenCalledOnce();
		expect(sink.abort).not.toHaveBeenCalled();
		expect(chunks.length).toBeLessThan(100);
		expect(chunks.reduce((largest, chunk) => Math.max(largest, chunk.length), 0)).toBeLessThan(
			64 * 1024 + 1
		);
		const result = JSON.parse(chunks.join('')) as {
			exportedAt: string;
			rows: Array<{ index: number; value: string }>;
		};
		expect(result.exportedAt).toBe('2026-07-26T12:00:00.000Z');
		expect(result.rows).toHaveLength(rowCount);
		expect(result.rows[0]).toEqual({ index: 0, value: 'row-0' });
		expect(result.rows.at(-1)).toEqual({
			index: rowCount - 1,
			value: `row-${rowCount - 1}`,
		});
	});

	it('splits oversized rows by encoded UTF-8 bytes without corrupting Unicode', async () => {
		const oversizedRow = {
			ascii: 'x'.repeat(150_000),
			unicode: '🙂'.repeat(40_000),
		};
		const { chunks, sink } = createRecordingSink();
		const stringify = vi.spyOn(JSON, 'stringify');

		await writeJsonDownload(sink, jsonArray([jsonValue(oversizedRow)]));

		expect(stringify).not.toHaveBeenCalled();
		expect(chunks.length).toBeGreaterThan(4);
		for (const chunk of chunks) {
			expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(64 * 1024);
		}
		expect(JSON.parse(chunks.join(''))).toEqual([oversizedRow]);
		stringify.mockRestore();
	});

	it('preserves JSON edge-case semantics in the bounded serializer', async () => {
		const { chunks, sink } = createRecordingSink();
		const arrayValues = [
			undefined,
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		delete arrayValues[1];
		const value = {
			controls: '\b\t\n\f\r\u0000"\\',
			surrogatePair: '🙂',
			loneHighSurrogate: '\ud800',
			loneLowSurrogate: '\udfff',
			omittedUndefined: undefined,
			omittedFunction: () => undefined,
			omittedSymbol: Symbol('omitted'),
			arrayValues,
		};

		await writeJsonDownload(sink, jsonValue(value));

		expect(JSON.parse(chunks.join(''))).toEqual({
			controls: value.controls,
			surrogatePair: value.surrogatePair,
			loneHighSurrogate: value.loneHighSurrogate,
			loneLowSurrogate: value.loneLowSurrogate,
			arrayValues: [null, null, null, null, null],
		});
	});

	it('rejects circular values and non-plain objects', async () => {
		const circular: Record<string, unknown> = {};
		circular['self'] = circular;
		const circularDestination = createRecordingSink();
		const nonPlainDestination = createRecordingSink();

		await expect(writeJsonDownload(circularDestination.sink, jsonValue(circular))).rejects.toThrow(
			'circular'
		);
		await expect(
			writeJsonDownload(nonPlainDestination.sink, jsonValue(new Date()))
		).rejects.toThrow('non-plain');

		expect(circularDestination.sink.abort).toHaveBeenCalledOnce();
		expect(nonPlainDestination.sink.abort).toHaveBeenCalledOnce();
	});

	it('aborts the destination instead of leaving a silently truncated file', async () => {
		const { sink } = createRecordingSink();
		const failure = new Error('page download failed');
		const failingValue: JsonValueWriter = async () => {
			throw failure;
		};

		await expect(
			writeJsonDownload(sink, jsonObject([['rows', jsonArray([jsonValue(1), failingValue])]]))
		).rejects.toBe(failure);

		expect(sink.close).not.toHaveBeenCalled();
		expect(sink.abort).toHaveBeenCalledWith(failure);
	});

	it('streams a large staged body into its metadata object without buffering the attachment', async () => {
		const attachment = 'x'.repeat(2_000_000);
		const content = new TextEncoder().encode(JSON.stringify({ attachment, available: true }));
		const sourceChunkSize = 16 * 1024;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < content.length; offset += sourceChunkSize) {
					controller.enqueue(content.slice(offset, offset + sourceChunkSize));
				}
				controller.close();
			},
		});
		const { chunks, sink } = createRecordingSink();

		await writeJsonDownload(
			sink,
			jsonObjectWithStreamedProperties({ _id: 'message_1', subject: 'Hello' }, body)
		);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.reduce((largest, chunk) => Math.max(largest, chunk.length), 0)).toBeLessThan(
			64 * 1024 + 1
		);
		expect(JSON.parse(chunks.join(''))).toEqual({
			_id: 'message_1',
			subject: 'Hello',
			attachment,
			available: true,
		});
	});
});

describe('account JSON export', () => {
	it('streams every row from a large paginated account export', async () => {
		const rowCount = 50_000;
		const pageSize = 100;
		const exportSessionId = 'accountExportSession_1';
		const action = vi.fn(async (_reference: unknown, untypedArgs: unknown) => {
			const args = untypedArgs as {
				resource?: string;
				cursor?: string;
				exportSessionId?: string;
			};
			if (!args.resource) {
				return {
					exportSessionId,
					userProfile: {
						email: 'owner@example.com',
						createdAt: 1,
						updatedAt: 2,
					},
					exportedAt: 3,
				};
			}
			expect(args.exportSessionId).toBe(exportSessionId);
			if (args.resource !== 'externalMailAccounts') {
				return { pageJson: [], isDone: true, continueCursor: '' };
			}
			const start = Number(args.cursor ?? 0);
			const end = Math.min(start + pageSize, rowCount);
			return {
				pageJson: Array.from({ length: end - start }, (_, offset) =>
					JSON.stringify({ _id: `external_${start + offset}` })
				),
				isDone: end === rowCount,
				continueCursor: end === rowCount ? '' : String(end),
			};
		});
		const client = { action } as unknown as ConvexClient;
		const { chunks, sink } = createRecordingSink();

		await writeAccountJsonExport(client, 'user_1', sink);

		const result = JSON.parse(chunks.join('')) as {
			exportSessionId?: string;
			personalData: { externalMailAccounts: Array<{ _id: string }> };
		};
		expect(result.exportSessionId).toBeUndefined();
		expect(result.personalData.externalMailAccounts).toHaveLength(rowCount);
		expect(result.personalData.externalMailAccounts.at(-1)).toEqual({
			_id: `external_${rowCount - 1}`,
		});
		expect(chunks.length).toBeLessThan(100);
		expect(
			action.mock.calls.filter(
				([, args]) => (args as { resource?: string }).resource === 'externalMailAccounts'
			)
		).toHaveLength(rowCount / pageSize);
	});

	it('acknowledges staged content only after it has streamed and omits staging capabilities', async () => {
		const exportSessionId = 'accountExportSession_1';
		const artifactId = 'accountExportArtifact_1';
		let contentStreamed = false;
		const action = vi.fn(async (_reference: unknown, untypedArgs: unknown) => {
			const args = untypedArgs as {
				resource?: string;
				artifactId?: string;
				organizationId?: string;
			};
			if (args.artifactId) {
				expect(contentStreamed).toBe(true);
				expect(args.artifactId).toBe(artifactId);
				return true;
			}
			if (!args.resource) {
				return {
					exportSessionId,
					userProfile: { email: 'owner@example.com', createdAt: 1, updatedAt: 2 },
					exportedAt: 3,
				};
			}
			if (args.resource === 'organizationMemberships') {
				return {
					pageJson: [
						JSON.stringify({
							organizationId: 'org_1',
							role: 'owner',
							organization: { _id: 'org_1', name: 'Owlat' },
						}),
					],
					isDone: true,
					continueCursor: '',
				};
			}
			if (args.resource === 'emailTemplates' && args.organizationId === 'org_1') {
				return {
					pageJson: [
						JSON.stringify({
							_id: 'template_1',
							name: 'Welcome',
							contentDownloadUrl: 'https://example.test/export-content',
							contentArtifactId: artifactId,
							contentLeaseToken: 'lease-1',
						}),
					],
					isDone: true,
					continueCursor: '',
				};
			}
			return { pageJson: [], isDone: true, continueCursor: '' };
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				const content = new TextEncoder().encode(
					JSON.stringify({ editorContent: { availability: 'available', value: [] } })
				);
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							contentStreamed = true;
							controller.enqueue(content);
							controller.close();
						},
					}),
					{ status: 200 }
				);
			})
		);
		const client = { action } as unknown as ConvexClient;
		const { chunks, sink } = createRecordingSink();

		await writeAccountJsonExport(client, 'user_1', sink);

		const result = JSON.parse(chunks.join('')) as {
			organizations: Array<{
				data: {
					emailTemplates: Array<Record<string, unknown>>;
				};
			}>;
		};
		expect(result.organizations[0]!.data.emailTemplates[0]).toEqual({
			_id: 'template_1',
			name: 'Welcome',
			editorContent: { availability: 'available', value: [] },
		});
		expect(action.mock.calls.filter(([, args]) => 'artifactId' in (args as object))).toHaveLength(
			1
		);
	});
});
