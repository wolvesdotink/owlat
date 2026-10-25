/**
 * Per-rule parity between each text-matching boundary gate and the oxlint rule
 * that replaces it (scripts/ast-gate-parity.ts). Every case runs the REAL old
 * gate and the REAL oxlint, with the repository config, over one throwaway
 * tree. The corpus is the old gate's own conformance cases (written as code
 * that compiles: builders imported, not left unbound) plus the spellings the
 * old gate admits it cannot see. Each gate must report something here, so a
 * pass is never two empty scans, and the sites only one side reports are
 * pinned with the reason:
 *
 *   only the rule: what a grep cannot see (a wrapped definition, an alias, a
 *                  shorthand key, a call longer than the span cap, …)
 *   only the gate: text the grep mistakes for code (a comment, a string), or a
 *                  name no import binds (code that cannot compile)
 *
 * The suite also lints each tree from the workspace directory, the way
 * `apps/api`'s own `lint` runs, and requires the same findings.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	compareGates,
	type Comparison,
	type GateName,
	KNOWN_DIFFERENCES,
	unexplained,
} from '../ast-gate-parity';
import { apiTree, removeTrees } from './convexGates.testlib';
import { parseLintReport } from '../lint-diagnostics';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const roots: string[] = [];
afterAll(() => removeTrees(roots));

/** A tree with the real gates; `files` are repository-relative. */
async function tree(files: Record<string, string>): Promise<string> {
	const apiFiles: Record<string, string> = {};
	const other: Record<string, string> = {};
	for (const [path, contents] of Object.entries(files)) {
		if (path.startsWith('apps/api/')) apiFiles[path.slice('apps/api/'.length)] = contents;
		else other[path] = contents;
	}
	const root = await apiTree(apiFiles, roots);
	const crypto = 'scripts/check-crypto-primitives.sh';
	await mkdir(join(root, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, crypto), join(root, crypto));
	for (const [path, contents] of Object.entries(other)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), contents, 'utf8');
	}
	return root;
}

const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

const AUTHED = "import { authedMutation, authedQuery, publicQuery } from '../lib/authedFunctions';";
const SERVER = "import { internalMutation } from '../_generated/server';";

const OPEN_CODED_HMAC = lines(
	'async function hmacHex(secret: string, data: string) {',
	'\tconst key = await crypto.subtle.importKey(',
	"\t\t'raw',",
	'\t\tnew TextEncoder().encode(secret),',
	"\t\t{ name: 'HMAC', hash: 'SHA-256' },",
	'\t\tfalse,',
	"\t\t['sign']",
	'\t);',
	"\treturn crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));",
	'}'
);

interface ParityCase {
	readonly gate: GateName;
	readonly files: Record<string, string>;
	readonly onlyOld: readonly string[];
	readonly onlyNew: readonly string[];
}

const CASES: readonly ParityCase[] = [
	{
		gate: 'crypto',
		files: {
			'apps/api/convex/lib/crypto.ts': OPEN_CODED_HMAC,
			'packages/shared/src/constantTimeEqual.ts':
				'export const constantTimeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));\n',
			'apps/convex-fn-proxy/src/allowlist.ts':
				'export const eq = (a, b) => timingSafeEqual(a, b);\n',
			'apps/api/convex/mail/newRoute.ts': OPEN_CODED_HMAC,
			'apps/mta/src/auth/apiKey.ts': lines(
				"import { timingSafeEqual } from 'node:crypto';",
				'export const eq = (a: Buffer, b: Buffer) => timingSafeEqual(a, b);'
			),
			'apps/mta/src/auth/alias.ts': lines(
				"import { timingSafeEqual as safeEqual } from 'node:crypto';",
				'export const eq = (a: Buffer, b: Buffer) => safeEqual(a, b);'
			),
			'apps/imap/src/auth/destructure.cjs': lines(
				"const { timingSafeEqual: eq } = require('node:crypto');",
				'module.exports = (a, b) => eq(a, b);'
			),
			'apps/web/app/components/Sig.vue': lines(
				'<script setup lang="ts">',
				"import { timingSafeEqual } from 'node:crypto';",
				'</script>'
			),
			'apps/api/convex/mail/objectForm.ts': lines(
				"export const sig = await crypto.subtle.sign({ name: 'HMAC' }, key, data);",
				'export const ok = await crypto.subtle.verify(',
				'\t{ hash: "SHA-256", name: "HMAC" },',
				'\tkey,',
				'\tsignature,',
				'\tdata',
				');',
				"export const rsa = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, s, d);",
				"export const v = await crypto.subtle.importKey('raw', bytes, algorithm, false, ['sign']);"
			),
			'apps/api/convex/lib/loop.ts': lines(
				'let diff = 0;',
				'for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);',
				'let sum = 0;',
				'for (let i = 0; i < a.length; i++) sum = sum + (a[i] ^ b[i]);',
				'const mixed = a ^ b;',
				'hash = (hash ^ byte) >>> 0;',
				"re += '^' + escaped;"
			),
			'apps/api/convex/lib/prose.ts': lines(
				'/** Never call timingSafeEqual( directly or importKey(… "HMAC" …) by hand. */',
				'export {};'
			),
			// Only the rule: the spellings the gate's header admits it misses.
			'apps/api/convex/lib/missed.ts': lines(
				'let result = 0;',
				'for (let i = 0; i < a.length; i++) {',
				'\tresult |=',
				'\t\ta.charCodeAt(i) ^ b.charCodeAt(i);',
				'}',
				"await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);",
				"await crypto.subtle.sign('hmac', key, data);"
			),
			// Only the gate: the name inside a string is not a use.
			'apps/api/convex/lib/message.ts':
				"export const hint = 'call timingSafeEqual through the helper';\n",
		},
		onlyOld: ['apps/api/convex/lib/message.ts:1'],
		onlyNew: [
			'apps/api/convex/lib/missed.ts:3',
			'apps/api/convex/lib/missed.ts:6',
			'apps/api/convex/lib/missed.ts:7',
		],
	},
	{
		gate: 'env',
		files: {
			'apps/api/convex/lib/env.ts':
				'export const get = (k: string) => process.env[k] ?? process.env.FALLBACK;\n',
			'apps/api/convex/delivery/poller.ts': lines(
				'export const a = process.env.SNDS_DATA_FEED_URLS;',
				"export const b = process.env['SNDS_DATA_FEED_URLS'];",
				'export const c = process.env[`SNDS_${suffix}`];',
				'export const { SNDS_DATA_FEED_URLS } = process.env;',
				'export const d = process.env?.SNDS_DATA_FEED_URLS;',
				'export const all = Object.entries(process.env);',
				'export const g = globalThis.process.env.FOO;'
			),
			'apps/api/convex/delivery/__tests__/fixtures.ts': "export const m = process.env['MODE'];\n",
			'apps/api/convex/delivery/poller.test.ts': 'export const flag = process.env.CI;\n',
			// Both: the object reached without the `process.env` text.
			'apps/api/convex/delivery/forms.ts': lines(
				"import { env } from 'node:process';",
				"export const e = process['env'].FOO;",
				'export const { env: whole } = process;',
				'export const f = env.FOO;'
			),
			// Both: env destructured by assignment and by a parameter default.
			'apps/api/convex/delivery/assigned.ts': lines(
				'let env: NodeJS.ProcessEnv;',
				'({ env } = process);',
				'export const token = env.SECRET;',
				'export const read = ({ env: param } = process) => param.FOO;'
			),
			// Only the rule: `process` bound under another name, reached through
			// the global object, or copied by a rest element.
			'apps/api/convex/delivery/renamed.ts': lines(
				"import * as host from 'node:process';",
				'export const r = host.env.FOO;',
				'export const { process: { env: nested } } = globalThis;',
				'export const { argv, ...rest } = process;'
			),
			// Only the gate: prose and strings that name it.
			'apps/api/convex/delivery/prose.ts': lines(
				'// process.env is read only in lib/env.ts',
				"export const hint = 'process.env.FOO';"
			),
		},
		onlyOld: ['apps/api/convex/delivery/prose.ts:1', 'apps/api/convex/delivery/prose.ts:2'],
		onlyNew: [
			'apps/api/convex/delivery/renamed.ts:2',
			'apps/api/convex/delivery/renamed.ts:3',
			'apps/api/convex/delivery/renamed.ts:4',
		],
	},
	{
		gate: 'log-pii',
		files: {
			'apps/api/convex/inbound/log.ts': lines(
				"logWarn('[Inbound Email] duplicate delivery', {",
				'\tmessageId: args.messageId,',
				'\tfrom: args.from,',
				'\tto: args.to,',
				'\tsubject: args.subject,',
				'});',
				"logInfo('sent', { recipient: args.recipient });",
				"console.warn('bounced', { rcptTo: job.rcptTo });",
				"logWarn('ok', { from: redactEmailAddress(args.from), subject: redactSubject(s) });",
				"logInfo('delivered', { fromDomain: d, toCount: 3, senderId: id });",
				'// log-pii-safe: header NAMES, never their values',
				"logInfo('headers dropped', { from: HEADER_FROM, subject: HEADER_SUBJECT });",
				"logInfo('webhook received', {",
				'\t// log-pii-safe: the provider routing label, not a mailbox',
				'\tfrom: payload.queueName,',
				'});',
				"await ctx.runMutation(internal.inbox.transition, { to: 'archived', from: args.from });",
				"logInfo('literal', { to: `ops@example.com` });",
				"logEvent('inbound.duplicate', {",
				'\tmessageId: args.messageId,',
				'\tdetail: { from: args.from, subject: args.subject },',
				"}, 'warn');",
				"logEvent('inbound.duplicate', {",
				'\tmessageId: args.messageId,',
				'\tdetail: {',
				'\t\tfrom: redactEmailAddress(args.from),',
				'\t\tsubject: redactSubject(args.subject),',
				'\t\tfromDomain: domainOf(args.from),',
				'\t},',
				"}, 'warn');",
				"import * as runtimeLog from '../lib/runtimeLog';",
				"runtimeLog.logEvent('inbound.bounced', { detail: { to: args.to } });"
			),
			// Both: a namespace import spelled `console` reads like the global.
			'apps/api/convex/inbound/stdout.ts': lines(
				"import * as console from 'node:console';",
				"console.warn('sent', { to: address });"
			),
			// Only the rule: forms the line-based awk cannot see.
			'apps/api/convex/inbound/missed.ts': lines(
				"logInfo('shorthand', { email });",
				"logInfo('quoted', { 'address': addr });",
				"logInfo('mixed', { to: args.to, subject: redactSubject(args.subject) });",
				"logInfo('long', {",
				...Array.from({ length: 22 }, (_, index) => `\tfield${index}: ${index},`),
				'\tsender: args.sender,',
				'});',
				"import { warn } from 'node:console';",
				"import * as out from 'node:console';",
				"warn('imported', { from: address });",
				"out.error('namespace', { subject: s });",
				"import { logEvent as emit } from '../lib/runtimeLog';",
				"emit('inbound.duplicate', { detail: { from: args.from } }, 'warn');"
			),
		},
		onlyOld: [],
		onlyNew: [
			'apps/api/convex/inbound/missed.ts:1',
			'apps/api/convex/inbound/missed.ts:2',
			'apps/api/convex/inbound/missed.ts:3',
			'apps/api/convex/inbound/missed.ts:27',
			'apps/api/convex/inbound/missed.ts:31',
			'apps/api/convex/inbound/missed.ts:32',
			'apps/api/convex/inbound/missed.ts:34',
		],
	},
	{
		gate: 'errors',
		files: {
			'apps/api/convex/workspaces/settings.ts': lines(
				AUTHED,
				"import { postboxQuery } from '../mail/_helpers';",
				SERVER,
				'export const rename = authedMutation({',
				'\targs: {},',
				'\thandler: async (ctx, args) => {',
				"\t\tif (!args.name) throw new Error('A name is required');",
				'\t\treturn null;',
				'\t},',
				'});',
				'export const list = postboxQuery({',
				"\thandler: async () => { throw new Error('list'); },",
				'});',
				'export const sync = internalMutation({',
				"\thandler: async () => { throw new Error('invariant'); },",
				'});',
				'function assertName(name: string) {',
				"\tif (!name) throw new Error('A name is required');",
				'}'
			),
			'apps/api/convex/workspaces/coded.ts':
				"export const fail = () => { throw new ConvexError({ code: 'NOPE' }); };\n",
			// Only the rule: a wrapped definition, `Error()` without `new`, an
			// aliased ConvexError and a subclass.
			'apps/api/convex/workspaces/missed.ts': lines(
				AUTHED,
				"import { ConvexError as Coded } from 'convex/values';",
				'export const wrapped =',
				'\tauthedMutation({',
				"\t\thandler: async () => { throw new Error('wrapped'); },",
				'\t});',
				'export const called = authedQuery({',
				"\thandler: async () => { throw Error('no new'); },",
				'});',
				"export const fail = () => { throw new Coded({ code: 'NOPE' }); };",
				'export class Refused extends Coded<string> {}'
			),
			// Only the gate: text in a comment, and a builder no import binds.
			'apps/api/convex/workspaces/prose.ts': lines(
				AUTHED,
				'export const note = authedQuery({',
				"\t// never throw new Error('x') here",
				'\thandler: async () => null,',
				'});',
				'// new ConvexError(...) belongs in _utils/errors.ts',
				'export const unbound = adminQuery({',
				"\thandler: async () => { throw new Error('unbound'); },",
				'});'
			),
		},
		onlyOld: [
			'apps/api/convex/workspaces/prose.ts:3',
			'apps/api/convex/workspaces/prose.ts:6',
			'apps/api/convex/workspaces/prose.ts:8',
		],
		onlyNew: [
			'apps/api/convex/workspaces/missed.ts:10',
			'apps/api/convex/workspaces/missed.ts:11',
			'apps/api/convex/workspaces/missed.ts:5',
			'apps/api/convex/workspaces/missed.ts:8',
		],
	},
	{
		gate: 'public-functions',
		files: {
			'apps/api/convex/contacts/list.ts': lines(
				"import { query, mutation } from '../_generated/server';",
				'export const list = query({ args: {}, handler: async () => null });',
				'export const save =',
				'\tmutation({ args: {}, handler: async () => null });',
				'export const alias = query;'
			),
			'apps/api/convex/contacts/safe.ts': lines(
				AUTHED,
				'export const list = authedQuery({ handler: async (ctx) => ctx.db.query("contacts").collect() });'
			),
			// Only the rule: an aliased import, a namespace member, the generic original.
			'apps/api/convex/contacts/missed.ts': lines(
				"import { action as run } from '../_generated/server';",
				"import * as server from '../_generated/server';",
				"import { queryGeneric } from 'convex/server';",
				'export const a = run({ handler: async () => null });',
				'export const b = server.query({ handler: async () => null });',
				'export const c = queryGeneric({ handler: async () => null });'
			),
			// Only the gate: a comment, and a name no import binds.
			'apps/api/convex/contacts/prose.ts': lines(
				'// const legacy = query(…) used to live here',
				'export const unbound = mutation({ handler: async () => null });'
			),
		},
		onlyOld: ['apps/api/convex/contacts/prose.ts:1', 'apps/api/convex/contacts/prose.ts:2'],
		onlyNew: [
			'apps/api/convex/contacts/missed.ts:4',
			'apps/api/convex/contacts/missed.ts:5',
			'apps/api/convex/contacts/missed.ts:6',
		],
	},
	{
		gate: 'session-threading',
		files: {
			'apps/api/convex/workspaces/rename.ts': lines(
				AUTHED,
				SERVER,
				"import { getMutationContext, requireOrgPermission } from '../lib/sessionOrganization';",
				'export const rename = authedMutation({',
				'\thandler: async (ctx) => {',
				'\t\tconst { userId } = await getMutationContext(ctx);',
				'\t},',
				'});',
				'export const threaded = authedMutation({',
				'\thandler: async (ctx, args, session) => session.userId,',
				'});',
				'// session: switches the active org before reading',
				'export const optedOut = authedMutation({',
				'\thandler: async (ctx) => getMutationContext(ctx),',
				'});',
				'export const soft = publicQuery({',
				'\thandler: async (ctx) => requireOrgPermission(ctx, "x"),',
				'});',
				'export const sync = internalMutation({',
				'\thandler: async (ctx) => getMutationContext(ctx),',
				'});'
			),
			// Only the rule: a wrapped definition and an aliased builder.
			'apps/api/convex/workspaces/missed.ts': lines(
				"import { authedQuery as read } from '../lib/authedFunctions';",
				"import { getMutationContext } from '../lib/sessionOrganization';",
				'export const wrapped =',
				'\tread({',
				'\t\thandler: async (ctx) => getMutationContext(ctx),',
				'\t});'
			),
			// Only the gate: a helper named in a comment.
			'apps/api/convex/workspaces/prose.ts': lines(
				AUTHED,
				'export const get = authedQuery({',
				"\t// the floor already ran requireOrgPermission(ctx, 'organization:manage')",
				'\thandler: async (ctx, args, session) => session.activeOrganizationId,',
				'});'
			),
		},
		onlyOld: ['apps/api/convex/workspaces/prose.ts:get'],
		onlyNew: ['apps/api/convex/workspaces/missed.ts:wrapped'],
	},
	{
		gate: 'feature-floors',
		files: {
			'apps/api/convex/mail/moves.ts': lines(
				AUTHED,
				"import { postboxQuery } from './_helpers';",
				'export const start = publicQuery({',
				"\thandler: async (ctx) => { await assertFeatureEnabled(ctx, 'mail.external'); },",
				'});',
				'export async function requireExternal(ctx: unknown) {',
				'\tawait assertFeatureEnabled(ctx, "mail.external");',
				'}',
				'export const drafts = authedQuery({ handler: async () => null });',
				'export const gated = postboxQuery({',
				"\thandler: async (ctx) => { await assertFeatureEnabled(ctx, 'ai.autonomy'); },",
				'});'
			),
			'apps/api/convex/campaigns/campaigns.ts': lines(
				AUTHED,
				'export const start = authedMutation({',
				"\thandler: async (ctx) => { await assertFeatureEnabled(ctx, 'campaigns'); },",
				'});'
			),
			'apps/api/convex/workspaces/settings.ts': lines(
				AUTHED,
				'export const start = authedMutation({',
				"\thandler: async (ctx) => { await assertFeatureEnabled(ctx, 'mail.external'); },",
				'});'
			),
			// Only the rule: an aliased bare builder, a differently named ctx, and
			// a non-exported helper the gate names after the export above it.
			'apps/api/convex/mail/missed.ts': lines(
				"import { authedMutation as write } from '../lib/authedFunctions';",
				"import { postboxQuery } from './_helpers';",
				'export const save = write({ handler: async () => null });',
				'export const read = postboxQuery({ handler: async () => null });',
				'const helper = async (ctx: unknown) => {',
				"\tawait assertFeatureEnabled(ctx, 'mail.external');",
				'};',
				'export async function check(context: unknown) {',
				"\tawait assertFeatureEnabled(context, 'mail.external');",
				'}'
			),
			// Only the gate: an assert inside a one-line block comment.
			'apps/api/convex/mail/prose.ts': lines(
				"import { postboxQuery } from './_helpers';",
				'export const read = postboxQuery({',
				"\thandler: async (ctx) => { /* await assertFeatureEnabled(ctx, 'mail.external') */ },",
				'});'
			),
		},
		onlyOld: ['apps/api/convex/mail/missed.ts:read', 'apps/api/convex/mail/prose.ts:read'],
		onlyNew: [
			'apps/api/convex/mail/missed.ts:check',
			'apps/api/convex/mail/missed.ts:helper',
			'apps/api/convex/mail/missed.ts:save',
		],
	},
];

/** The owlat findings of one oxlint run from `cwd` over `targets`, as absolute `path:line:rule`. */
function owlatFindings(cwd: string, targets: string[]): string[] {
	const run = spawnSync(
		join(REPOSITORY_ROOT, 'node_modules/.bin/oxlint'),
		['--config', join(REPOSITORY_ROOT, 'oxlintrc.json'), '--format', 'json', ...targets],
		{ cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
	);
	return parseLintReport(run.stdout)
		.filter((d) => (d.code ?? '').startsWith('owlat('))
		.map((d) => `${resolve(cwd, d.filename)}:${d.labels?.[0]?.span.line ?? 0}:${d.code}`)
		.sort();
}

describe.each(CASES)('$gate: the text gate and its rule', ({ gate, files, onlyOld, onlyNew }) => {
	let comparison: Comparison;
	let root: string;

	it('differ only where the grep misreads text or misses a form', async () => {
		root = await tree(files);
		[comparison] = compareGates(root, [gate]) as [Comparison];
		expect(comparison.old.length).toBeGreaterThan(onlyOld.length);
		expect(comparison.new.length).toBeGreaterThan(onlyNew.length);
		expect(comparison.onlyOld).toEqual([...onlyOld].sort());
		expect(comparison.onlyNew).toEqual([...onlyNew].sort());
	});

	it('report the same from the repository root and from apps/api', () => {
		const fromRoot = owlatFindings(root, ['apps/api/convex']);
		expect(fromRoot.length).toBeGreaterThan(0);
		expect(owlatFindings(join(root, 'apps/api'), ['convex'])).toEqual(fromRoot);
	});
});

describe('unexplained differences', () => {
	const comparison: Comparison = {
		gate: 'env',
		old: ['a.ts:1', 'b.ts:2'],
		new: ['a.ts:1', 'c.ts:3'],
		onlyOld: ['b.ts:2'],
		onlyNew: ['c.ts:3'],
	};

	it('fail in both directions unless listed with a reason', () => {
		expect(unexplained([comparison], [])).toEqual({
			differences: ['env: only the text gate reports b.ts:2', 'env: only the rule reports c.ts:3'],
			stale: [],
		});
		const known = [
			{ gate: 'env', site: 'b.ts:2', side: 'old', reason: 'a comment' },
			{ gate: 'env', site: 'c.ts:3', side: 'new', reason: 'a bracket read' },
		] as const;
		expect(unexplained([comparison], known)).toEqual({ differences: [], stale: [] });
	});

	it('flag a listed difference that no longer differs, for the gates compared', () => {
		const known = [
			{ gate: 'env', site: 'gone.ts:1', side: 'old', reason: 'fixed' },
			{ gate: 'crypto', site: 'other.ts:1', side: 'new', reason: 'not compared' },
		] as const;
		expect(unexplained([{ ...comparison, onlyOld: [], onlyNew: [] }], known).stale).toEqual([
			'env: old gone.ts:1',
		]);
	});

	it('every repository entry gives a reason', () => {
		for (const entry of KNOWN_DIFFERENCES) expect(entry.reason.trim()).not.toBe('');
	});
});
