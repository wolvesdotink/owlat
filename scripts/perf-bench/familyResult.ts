/**
 * Reads back what a measurement process wrote with `writeFamilyResult`. The
 * driver aggregates every sample it reads, so a result file of the wrong shape
 * (a stale format, a half-written file) fails the run here instead of turning
 * into NaN statistics in the report. Kept apart from sample.ts, which specs in
 * every workspace import and which stays free of repository imports.
 */
import { readFileSync } from 'node:fs';
import {
	arrayOf,
	decodeJson,
	type Decoder,
	number,
	object,
	oneOf,
	optional,
	recordOf,
	string,
} from '../json';
import type { FamilyResult } from './sample';

const decodeFamilyResult: Decoder<FamilyResult> = object({
	family: string,
	title: string,
	dataset: recordOf(oneOf<string | number>('a string or a number', string, number)),
	runtime: object({ node: string, v8: string }),
	tasks: arrayOf(object({ name: string, opsPerSample: number, samplesMs: arrayOf(number) })),
	scaling: optional(
		arrayOf(object({ name: string, small: string, large: string, factor: number }))
	),
});

export function readFamilyResult(path: string): FamilyResult {
	return decodeJson(readFileSync(path, 'utf8'), decodeFamilyResult, path);
}
