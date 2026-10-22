import rule from '../noPollingLoopInTests.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'cases.test.ts';
const message = /^Polling loop in a test/;
const sleep = 'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n';

ruleTester.run('owlat/no-polling-loop-in-tests', rule, {
	valid: [
		{
			name: 'a polling loop outside test files',
			filename: 'src/poller.ts',
			code: `${sleep}export async function poll(ready: () => boolean) { while (!ready()) await sleep(10); }`,
		},
		{
			name: 'a test file without any await',
			filename,
			code: 'let i = 0;\nwhile (i < 3) i++;',
		},
		{
			name: 'a loop that awaits real work',
			filename,
			code: 'let cursor: string | null = "a";\nwhile (cursor) { const page = await fetchPage(cursor); cursor = page.next; }',
		},
		{
			name: 'a fixed number of flushes',
			filename,
			code: "import { flushPromises } from '@vue/test-utils';\nfor (let i = 0; i < 3; i++) await flushPromises();\nfor (let i = 0; i < MAX * 3 + 1; i += 1) await Promise.resolve();\nlet n = 0;\nwhile (n++ < 3) await Promise.resolve();\nlet k = 5;\ndo { await Promise.resolve(); k -= 1; } while (k > 0);\nfor (let j = 0; items.length > j; j++) await Promise.resolve();",
		},
		{
			name: 'an endless loop without a conditional exit',
			filename,
			code: 'while (true) { await new Promise(setImmediate); }\nfor (;;) { await new Promise((r) => setTimeout(r, 0)); }',
		},
		{
			name: 'a for...of loop over cases',
			filename,
			code: `${sleep}for (const c of cases) { if (c.skip) continue; await sleep(1); }`,
		},
		{
			name: 'a wait inside a callback the loop creates',
			filename,
			code: 'while (!done) { emitter.once("x", async () => { await new Promise(setImmediate); }); done = await next(); }',
		},
		{
			name: 'a wait handed in as a parameter is unknown',
			filename,
			code: 'export async function until(ready: () => boolean, settle: () => Promise<void>) { while (!ready()) await settle(); }',
		},
		{
			name: 'awaiting calls that are not waits',
			filename,
			code: "import { mount } from '@vue/test-utils';\nimport { nextTick as vueNext } from './not-vue';\nconst work = async () => compute();\nfunction recurse(): Promise<void> { return recurse(); }\nlet other: () => Promise<void>;\nwhile (!ready()) { await mount(C); await vueNext(); await work(); await recurse(); await other(); await obj.method(); await api[key](); await make()(); await Promise.all([]); }",
		},
	],
	invalid: [
		{
			name: 'a predicate loop around a sleep',
			filename,
			code: `${sleep}while (!ready()) await sleep(10);`,
			errors: [{ message }],
		},
		{
			name: 'a bounded loop with a conditional exit around a timer promise',
			filename,
			code: 'for (let i = 0; i < 50; i++) { if (done) break; await new Promise((r) => setTimeout(r, 10)); }',
			errors: 1,
		},
		{
			name: 'an endless loop that returns once a condition holds',
			filename,
			code: 'for (;;) { if (lines().includes("OK")) return; await new Promise((r) => setTimeout(r, 5)); }',
			errors: 1,
		},
		{
			name: 'an else branch that throws on a deadline',
			filename,
			code: 'do { if (ok()) { /* keep going */ } else { throw new Error("late"); } await Promise.resolve(); } while (true);',
			errors: 1,
		},
		{
			name: 'tick helpers: flushPromises, vue nextTick, Promise.resolve and a local flush',
			filename,
			code: "import { flushPromises as flush } from '@vue/test-utils';\nimport { nextTick } from 'vue';\nconst settle = () => new Promise((r) => setTimeout(r, 0));\nasync function settleTwice() { await settle(); await settle(); }\nwhile (queue.length) await flush();\nwhile (!rendered()) await nextTick();\nwhile (pending > 0) await Promise.resolve();\nwhile (!a.done) await settle();\nwhile (!b.done) await settleTwice();",
			errors: 5,
		},
		{
			name: 'a counter combined with a predicate',
			filename,
			code: 'for (let i = 0; i < 100 && !destroyed; i++) { await new Promise(setImmediate); }',
			errors: 1,
		},
		{
			name: 'a counter the loop never advances is a predicate',
			filename,
			code: 'let i = 0;\nwhile (i < 3) { await Promise.resolve(); }',
			errors: 1,
		},
		{
			name: 'a counter whose bound is not fixed',
			filename,
			code: 'for (let i = 0; i < count(); i++) { await new Promise((r) => process.nextTick(r)); }',
			errors: 1,
		},
		{
			name: 'a timers/promises sleep in a loop under __tests__',
			filename: 'src/__tests__/helpers/redis.ts',
			code: "import { setTimeout as wait } from 'node:timers/promises';\nexport async function ready() { let up = false; while (!up) { up = await ping(); await wait(100); } }",
			errors: 1,
		},
		{
			name: 'each loop of a nested pair that polls',
			filename,
			code: 'while (!a()) { for (let i = 0; i < 3; i++) { if (b()) break; await Promise.resolve(); } }',
			errors: 2,
		},
	],
});
