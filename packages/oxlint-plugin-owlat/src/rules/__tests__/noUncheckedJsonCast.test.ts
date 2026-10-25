import rule from '../noUncheckedJsonCast.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = '/repo/apps/mta/src/routes/send.ts';
const error = [{ message: /^Unchecked JSON: a type argument or cast is not a check/ }];

ruleTester.run('owlat/no-unchecked-json-cast', rule, {
	valid: [
		{
			name: 'a read decoded to unknown',
			filename,
			code: 'export async function f(c: any) { const body: unknown = await c.req.json(); return body; }',
		},
		{
			name: 'a parse cast to unknown, then narrowed by a guard',
			filename,
			code: 'declare function isBody(v: unknown): v is { a: string };\nexport function f(t: string) { const v = JSON.parse(t) as unknown; return isBody(v) ? v.a : null; }',
		},
		{
			name: 'a binding declared unknown and assigned later',
			filename,
			code: 'export async function f(req: Request) { let input: unknown; input = await req.json(); return input; }',
		},
		{
			name: "Hono's response builder takes an argument and is not a read",
			filename,
			code: 'export const f = (c: any) => c.json({ ok: true }) as Response;',
		},
		{
			name: 'a cast of something that is not JSON',
			filename,
			code: 'export const f = (x: unknown) => (x as { a: string }).a;',
		},
		{
			name: 'a local JSON that shadows the global',
			filename,
			code: 'const JSON = { parse: (t: string) => t.length };\nexport const n = JSON.parse("x") as number;',
		},
		{
			name: 'a local readBody that is not h3',
			filename: '/repo/apps/updater/src/server.ts',
			code: 'function readBody<T>(x: T): T { return x; }\nexport const b = readBody<string>("x");',
		},
		{
			name: 'a test file may cast a fixture',
			filename: '/repo/apps/mta/src/routes/__tests__/send.test.ts',
			code: 'export async function f(res: Response) { return (await res.json()) as { error: string }; }',
		},
	],
	invalid: [
		{
			name: 'a type argument on a Hono read',
			filename,
			code: 'export async function f(c: any) { return await c.req.json<{ to: string }>(); }',
			errors: error,
		},
		{
			name: 'a type argument split over lines',
			filename,
			code: 'export async function f(c: any) {\n\treturn await c.req.json<{\n\t\tto: string;\n\t}>();\n}',
			errors: error,
		},
		{
			name: 'a typed read with a catch fallback is reported once, on the read',
			filename,
			code: 'export async function f(c: any) { return c.req.json<{ a?: string }>().catch(() => ({})); }',
			errors: error,
		},
		{
			name: 'a cast of an awaited response read',
			filename,
			code: 'export async function f(res: Response) { return (await res.json()) as { id: string }; }',
			errors: error,
		},
		{
			name: 'a cast through a catch fallback',
			filename,
			code: 'export async function f(c: any) { return (await c.req.json().catch(() => null)) as { a: string } | null; }',
			errors: error,
		},
		{
			name: 'a cast of JSON.parse',
			filename,
			code: 'export const f = (t: string) => JSON.parse(t) as { a: string };',
			errors: error,
		},
		{
			name: 'a double cast through unknown',
			filename,
			code: 'export const f = (t: string) => JSON.parse(t) as unknown as { a: string };',
			errors: error,
		},
		{
			name: 'an angle-bracket assertion',
			filename: '/repo/apps/mta/src/legacy.ts',
			code: 'export const f = (t: string) => <{ a: string }>JSON.parse(t);',
			errors: error,
		},
		{
			name: 'a cast to any',
			filename,
			code: 'export const f = (t: string) => JSON.parse(t) as any;',
			errors: error,
		},
		{
			name: 'an annotated declaration',
			filename,
			code: 'export async function f(req: Request) { const body: { a: string } = await req.json(); return body; }',
			errors: error,
		},
		{
			name: 'an assignment to a binding declared with a type',
			filename,
			code: 'export async function f(c: any) {\n\tlet body: { emails: string[] };\n\ttry {\n\t\tbody = await c.req.json();\n\t} catch {\n\t\treturn null;\n\t}\n\treturn body;\n}',
			errors: error,
		},
		{
			name: "h3's readBody with a type argument (auto-imported)",
			filename: '/repo/apps/web/server/api/self-update.post.ts',
			code: 'export default async (event: any) => (await readBody<{ targetVersion?: string }>(event))?.targetVersion;',
			errors: error,
		},
		{
			name: "h3's readBody imported by name and cast",
			filename: '/repo/apps/web/server/api/x.post.ts',
			code: "import { readBody } from 'h3';\nexport default async (event: any) => (await readBody(event)) as { a: string };",
			errors: error,
		},
	],
});
