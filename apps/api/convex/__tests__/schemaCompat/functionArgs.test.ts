import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { v, type ValidatorJSON } from 'convex/values';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	callerSurface,
	callIncompatibilities,
	readFunctions,
	workerPaths,
	type FunctionSignature,
} from './functions';
import { containmentGap, withoutValidatorField } from './containment';
import { readSnapshot } from './snapshot';

/**
 * PREVIOUS-RELEASE CALLERS STILL GET THROUGH. Between `convex-deploy` and the
 * container restart, and for as long as a browser tab or desktop client stays
 * open, the previous release's clients and workers call this release's
 * functions with the arguments they were built to send. This reads the
 * signatures in `previousRelease.json` (every public function, and each
 * internal function a worker addresses by path) and proves, from the
 * validators' structure (`containment.ts`), that each current validator
 * accepts every argument object the previous one did.
 *
 * A failure here means the PR removes or renames a function such a caller
 * uses, changes its kind, makes it internal, or rejects arguments it accepted:
 * an argument removed or renamed, a new required argument, an optional one made
 * required, a changed type, a narrowed union. The fix is the one-release shim
 * or the expand/contract sequence in `convex/CONVENTIONS.md` ("Old clients and
 * workers against new functions"), not an edit to the snapshot. Result shapes
 * are not checked here.
 */

/**
 * Functions the current release deliberately removed, as `module:name`. Like a
 * retired table, a function leaves only in the contract step: the previous
 * release no longer calls it (the release before kept it as a shim, see
 * `PREVIOUS_RELEASE_ENTRIES` in `scripts/entryWiringPreviousRelease.ts`). Name
 * it here in that same PR; drop the entry at the next snapshot refresh.
 */
const RETIRED_FUNCTIONS: ReadonlySet<string> = new Set();

/**
 * Arguments the current release deliberately removed, per function, as paths
 * into the arguments object (`.` between fields, `[]` for every array element).
 * Only once the previous release no longer sends the argument; the check then
 * reads the previous validator without it and still checks the rest.
 */
const RETIRED_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {};

const convexRoot = resolve(import.meta.dirname, '..', '..');

/** The current signatures of every function the snapshot names, from the modules that still exist. */
async function currentFunctions(
	previous: Readonly<Record<string, FunctionSignature>>
): Promise<Record<string, FunctionSignature>> {
	const modules = [...new Set(Object.keys(previous).map((path) => path.split(':')[0] ?? ''))];
	return readFunctions(
		convexRoot,
		modules.filter((module) => existsSync(join(convexRoot, `${module}.ts`)))
	);
}

describe('previous-release calls are still accepted', () => {
	const snapshot = readSnapshot();
	let current: Record<string, FunctionSignature> = {};

	beforeAll(async () => {
		current = await currentFunctions(snapshot.functions);
	});

	it('the snapshot holds the public functions and the worker-called internal ones', () => {
		const signatures = Object.values(snapshot.functions);
		expect(signatures.filter((s) => s.visibility === 'public').length).toBeGreaterThan(100);
		expect(signatures.filter((s) => s.visibility === 'internal').length).toBeGreaterThan(10);
	});

	it(`every call ${snapshot.release} could make is accepted by the current functions`, () => {
		expect(
			callIncompatibilities(snapshot.functions, current, RETIRED_FUNCTIONS, RETIRED_ARGUMENTS)
		).toEqual([]);
	});

	it('every current signature contains itself (no false gap on real validators)', () => {
		expect(
			Object.entries(current).flatMap(([path, signature]) => {
				const problem = containmentGap(signature.args, signature.args);
				return problem ? [`${path}: ${problem}`] : [];
			})
		).toEqual([]);
	});

	it('a renamed worker endpoint or a new required argument on the real snapshot fails', () => {
		const path = Object.keys(snapshot.functions).find(
			(candidate) =>
				snapshot.functions[candidate]?.visibility === 'internal' && candidate in current
		);
		if (path === undefined) throw new Error('the snapshot names no worker endpoint');
		const { [path]: renamed, ...withoutEndpoint } = current;
		expect(renamed).toBeDefined();
		expect(
			callIncompatibilities(snapshot.functions, {
				...withoutEndpoint,
				[`${path}V2`]: renamed as FunctionSignature,
			})
		).toEqual([`${path}: function is no longer exported`]);

		const signature = renamed as FunctionSignature;
		if (signature.args.type !== 'object') throw new Error(`${path} validates no arguments`);
		const fields = signature.args.value;
		const withArg = (optional: boolean): FunctionSignature => ({
			...signature,
			args: {
				type: 'object',
				value: { ...fields, cursor: { fieldType: { type: 'string' }, optional } },
			},
		});
		expect(
			callIncompatibilities(snapshot.functions, { ...current, [path]: withArg(true) })
		).toEqual([]);
		expect(
			callIncompatibilities(snapshot.functions, { ...current, [path]: withArg(false) })
		).toEqual([`${path}: cursor: new and required`]);
	});

	/** `current` with one argument of `path` replaced. */
	const withArgument = (
		path: string,
		name: string,
		field: { fieldType: ValidatorJSON; optional: boolean }
	) => {
		const signature = current[path];
		if (signature?.args.type !== 'object') throw new Error(`${path} has no object arguments`);
		return {
			...current,
			[path]: {
				...signature,
				args: { ...signature.args, value: { ...signature.args.value, [name]: field } },
			},
		};
	};

	it('a real string argument turned into an id fails', () => {
		expect(
			callIncompatibilities(
				snapshot.functions,
				withArgument('mail/filters:create', 'name', {
					fieldType: { type: 'id', tableName: 'users' },
					optional: false,
				})
			)
		).toEqual(['mail/filters:create: name: accepted string, now only id of users']);
	});

	it('a new required argument named like an inherited property fails', () => {
		for (const name of ['constructor', 'toString', '__proto__']) {
			expect(
				callIncompatibilities(
					snapshot.functions,
					withArgument('mail/filters:create', name, {
						fieldType: { type: 'string' },
						optional: false,
					})
				)
			).toEqual([`mail/filters:create: ${name}: new and required`]);
		}
	});

	it('a real worker argument union narrowed, or an optional one made required, fails', () => {
		const path = 'mail/imap/flags:storeFlags';
		expect(
			callIncompatibilities(
				snapshot.functions,
				withArgument(path, 'mode', {
					fieldType: {
						type: 'union',
						value: [
							{ type: 'literal', value: 'set' },
							{ type: 'literal', value: 'add' },
						],
					},
					optional: false,
				})
			)
		).toEqual([`${path}: mode: accepted "remove", now only "set" | "add"`]);
		expect(
			callIncompatibilities(
				snapshot.functions,
				withArgument(path, 'unchangedSinceModseq', {
					fieldType: { type: 'number' },
					optional: false,
				})
			)
		).toEqual([`${path}: unchangedSinceModseq: optional, now required`]);
	});

	it('names no retired function that is still exported', () => {
		expect([...RETIRED_FUNCTIONS].filter((path) => path in current)).toEqual([]);
	});

	it('names no retired argument that is still accepted', () => {
		const stillThere = Object.entries(RETIRED_ARGUMENTS).flatMap(([path, args]) => {
			const signature = current[path];
			if (!signature) return [`${path}: function is no longer exported`];
			return args.filter(
				(arg) =>
					JSON.stringify(withoutValidatorField(signature.args, arg)) !==
					JSON.stringify(signature.args)
			);
		});
		expect(stillThere).toEqual([]);
	});
});

describe('the call check itself', () => {
	const args = (fields: Parameters<typeof v.object>[0]) =>
		(v.object(fields) as unknown as { json: ValidatorJSON }).json;
	const signature = (
		fields: Parameters<typeof v.object>[0],
		overrides: Partial<FunctionSignature> = {}
	): FunctionSignature => ({
		kind: 'mutation',
		visibility: 'internal',
		args: args(fields),
		...overrides,
	});
	const fields = {
		folderId: v.id('mailFolders'),
		mode: v.union(v.literal('read'), v.literal('write')),
		uids: v.array(v.number()),
		since: v.optional(v.number()),
	};
	const previous = { 'mail/imap/flags:storeFlags': signature(fields) };
	const check = (current: FunctionSignature, retiredArguments = {}) =>
		callIncompatibilities(
			previous,
			{ 'mail/imap/flags:storeFlags': current },
			new Set(),
			retiredArguments
		);

	it('accepts unchanged and additive signatures: a new optional argument, a widened union', () => {
		expect(check(signature(fields))).toEqual([]);
		expect(check(signature({ ...fields, limit: v.optional(v.number()) }))).toEqual([]);
		expect(
			check(
				signature({
					...fields,
					mode: v.union(v.literal('read'), v.literal('write'), v.literal('append')),
				})
			)
		).toEqual([]);
		expect(check(signature(fields, { visibility: 'public' }))).toEqual([]);
	});

	it('rejects a narrowed argument union', () => {
		expect(check(signature({ ...fields, mode: v.literal('read') }))).toEqual([
			'mail/imap/flags:storeFlags: mode: accepted "write", now only "read"',
		]);
	});

	it('rejects a renamed worker endpoint unless it is retired', () => {
		expect(
			callIncompatibilities(previous, { 'mail/imap/flags:setFlags': signature(fields) })
		).toEqual(['mail/imap/flags:storeFlags: function is no longer exported']);
		expect(
			callIncompatibilities(
				previous,
				{ 'mail/imap/flags:setFlags': signature(fields) },
				new Set(['mail/imap/flags:storeFlags'])
			)
		).toEqual([]);
	});

	it('rejects a new required argument and an optional one made required', () => {
		expect(check(signature({ ...fields, mailboxId: v.id('mailboxes') }))).toEqual([
			'mail/imap/flags:storeFlags: mailboxId: new and required',
		]);
		expect(check(signature({ ...fields, since: v.number() }))).toEqual([
			'mail/imap/flags:storeFlags: since: optional, now required',
		]);
	});

	it('rejects a removed or renamed argument unless it is retired, and still checks the rest', () => {
		const { since: _since, ...withoutSince } = fields;
		expect(check(signature(withoutSince))).toEqual([
			'mail/imap/flags:storeFlags: since: no longer accepted',
		]);
		expect(check(signature({ ...withoutSince, after: v.optional(v.number()) }))).toEqual([
			'mail/imap/flags:storeFlags: since: no longer accepted',
		]);
		const retired = { 'mail/imap/flags:storeFlags': ['since'] };
		expect(check(signature(withoutSince), retired)).toEqual([]);
		expect(check(signature({ ...withoutSince, uids: v.array(v.string()) }), retired)).toEqual([
			'mail/imap/flags:storeFlags: uids[]: accepted number, now only string',
		]);
	});

	it('rejects a changed argument type', () => {
		expect(check(signature({ ...fields, folderId: v.id('mailboxes') }))).toEqual([
			'mail/imap/flags:storeFlags: folderId: accepted id of mailFolders, now only id of mailboxes',
		]);
	});

	it('rejects a changed kind and a public function made internal', () => {
		expect(check(signature(fields, { kind: 'action' }))).toEqual([
			'mail/imap/flags:storeFlags: was a mutation, now an action',
		]);
		expect(
			callIncompatibilities(
				{ 'campaigns/queries:list': signature(fields, { kind: 'query', visibility: 'public' }) },
				{ 'campaigns/queries:list': signature(fields, { kind: 'query' }) }
			)
		).toEqual(['campaigns/queries:list: was public, now internal']);
	});

	it('rejects validating arguments a function used to take unchecked', () => {
		const any = { type: 'any' } as const;
		const before = { 'x:y': { kind: 'query', visibility: 'public', args: any } } as const;
		expect(callIncompatibilities(before, { 'x:y': { ...before['x:y'], args: any } })).toEqual([]);
		expect(
			callIncompatibilities(before, {
				'x:y': signature(fields, { kind: 'query', visibility: 'public' }),
			})
		).toEqual([
			'x:y: (arguments): accepted any, now only {folderId: id of mailFolders, mode: "read" | "write", uids: number[], since?: number}',
		]);
	});
});

describe('the caller surface', () => {
	const fn = (visibility: FunctionSignature['visibility']): FunctionSignature => ({
		kind: 'query',
		visibility,
		args: { type: 'object', value: {} },
	});

	it('reads worker string paths, including ones split over lines', () => {
		const source = [
			"fetchEnvelopes: makeFunctionReference<'query', Args, Result>(",
			"\t'mail/imap/fetch:fetchEnvelopes'",
			'),',
			"claim: makeFunctionReference<'mutation'>('codeWorkTasks:claim'),",
		].join('\n');
		expect([...workerPaths([source])]).toEqual([
			'mail/imap/fetch:fetchEnvelopes',
			'codeWorkTasks:claim',
		]);
	});

	it('is every public function and only the internal ones a worker names', () => {
		expect(
			Object.keys(
				callerSurface(
					{ 'a:pub': fn('public'), 'a:worker': fn('internal'), 'a:inner': fn('internal') },
					new Set(['a:worker', 'b:gone'])
				)
			)
		).toEqual(['a:pub', 'a:worker']);
	});
});
