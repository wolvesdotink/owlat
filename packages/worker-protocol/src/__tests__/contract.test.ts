/**
 * The contract's types: what a worker passes and reads is the validators'
 * shape, with document ids as the plain strings they are on the wire.
 */

import { v, type Infer } from 'convex/values';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	defineEndpoint,
	type EndpointArgs,
	type EndpointResult,
	type EndpointReturns,
	type Wire,
} from '../contract';
import { getCredentialsForWorker } from '../mailSync/accounts';
import type { fetchEnvelopes } from '../imap/fetch';

describe('defineEndpoint', () => {
	it('accepts what it returns unless told otherwise', () => {
		const endpoint = defineEndpoint({
			path: 'test/module:fn',
			kind: 'query',
			args: {},
			returns: v.null(),
		});
		expect(endpoint.accepts).toBe(endpoint.returns);
		expect(Object.isFrozen(endpoint)).toBe(true);
	});

	it('keeps a wider consumer acceptance apart from what the backend returns', () => {
		expect(getCredentialsForWorker.accepts).not.toBe(getCredentialsForWorker.returns);
		expectTypeOf<EndpointResult<typeof getCredentialsForWorker>>().toMatchTypeOf<
			EndpointReturns<typeof getCredentialsForWorker> | null | { imapHost: string }
		>();
	});
});

describe('Wire', () => {
	it('reads a document id as a string, through arrays, objects and unions', () => {
		const validator = v.union(
			v.null(),
			v.object({ ids: v.array(v.id('mailMessages')), one: v.optional(v.id('mailFolders')) })
		);
		expectTypeOf<Wire<Infer<typeof validator>>>().toEqualTypeOf<null | {
			ids: string[];
			one?: string;
		}>();
	});

	it('types the arguments a worker passes the same way', () => {
		expectTypeOf<EndpointArgs<typeof fetchEnvelopes>>().toEqualTypeOf<{
			folderId: string;
			uidLow: number;
			uidHigh: number;
			ranges?: { low: number; high: number }[];
			limit?: number;
		}>();
	});
});
