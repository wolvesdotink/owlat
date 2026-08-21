/**
 * THE SCAFFOLD'S CONFORMANCE GATE — `owlat plugins create --template
 * send-provider` output, driven UNMODIFIED through the shipped core modules (the
 * seams plan's P3.4, its acceptance criterion A7).
 *
 * P3.3's parity proof (`pluginProviderParity.test.ts`) answers "can a package be
 * a provider?" against a hand-written fixture ESP. This one answers the question
 * D4's policy actually rests on — "is the package we HAND an author already such
 * a provider?" — and it answers it against the generator's real output: the
 * subject is `../fixtures/scaffolded/bundle.ts`, which calls `buildScaffold`,
 * writes the emitted files to a directory, imports the emitted TypeScript and
 * composes it through the real host and renderer. No file is edited in between,
 * and the last block asserts that mechanically.
 *
 * THE HOST'S RULES ARE NOT RESTATED HERE. Routability under every strategy, the
 * fallback arm and its per-domain proof gate, arm attribution, the return-path
 * fold, the feedback route's registration and re-validation, the derived domain
 * status and the credential vocabulary are one body —
 * `describeSendProviderConformance` — run against BOTH subjects, because they are
 * the host's rules rather than either subject's. What is written out below it is
 * only what is specific to THIS subject: the emitted send module driven through
 * governed dispatch (a stubbed `fetch` is its "network"; the fixture ESP has a
 * recorded attempt log instead), the generator's byte-for-byte output, and the
 * bindings to the authoring guide.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// ── The composition, in the four places a host reads it ─────────────────────
//
// Each factory awaits the fixture lazily, so the mock registry does not depend on
// the order Vitest evaluates this file's own imports in. The fixture memoizes the
// PROMISE, so all five frames below share one materialised bundle.

vi.mock('@owlat/api/generated/sendTransportCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).sendTransports,
}));

vi.mock('@owlat/api/generated/sendTransportWebhookCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).webhooks,
}));

vi.mock('@owlat/api/generated/sendTransportDomainIdentityCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).domainIdentities,
}));

vi.mock('@owlat/api/generated/plugins', async () => ({
	bundledPluginComposition: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).roster,
}));

vi.mock('@owlat/api/generated/sendTransportModules', async () => {
	const bundle = await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle();
	const entry = bundle.sendTransports[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: [
			{ kind: entry['kind'], pluginId: entry['pluginId'], module: bundle.transport },
		],
	};
});

vi.mock('@owlat/api/generated/sendTransportWebhookModules', async () => {
	const bundle = await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle();
	const entry = bundle.webhooks[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: [
			{ kind: entry['kind'], pluginId: entry['pluginId'], module: bundle.webhook },
		],
	};
});

vi.mock('@owlat/api/generated/sendTransportDomainIdentityModules', async () => {
	const bundle = await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle();
	const entry = bundle.domainIdentities[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: [
			{ kind: entry['kind'], pluginId: entry['pluginId'], module: bundle.domainIdentity },
		],
	};
});

import { type SendProviderKind } from '@owlat/api/sendProviders/catalog';
import { EmailErrorCode } from '@owlat/api/sendProviders/types';
import { sendProviderDispatch } from '@owlat/api/sendProviders/dispatch';
import {
	describeSendProviderConformance,
	type ConformanceSignatureContract,
} from '../sendProviderConformance';
import { repositoryFilesMentioning } from '../repository';
import {
	cleanupScaffoldedBundle,
	SCAFFOLDED_PACKAGE_NAME,
	SCAFFOLDED_PLUGIN_ID,
	scaffoldedBundle,
	type ScaffoldedBundle,
} from '../fixtures/scaffolded/bundle';

/**
 * The bundle, resolved once for the whole file.
 *
 * `await` at module scope rather than in a `beforeAll`, because the derived
 * constants below (the kind, the variable names, the signature contract) are what
 * every `describe` is written against, and a hook would leave them undefined
 * while the collector ran.
 */
const bundle: ScaffoldedBundle = await scaffoldedBundle();
const entry = bundle.sendTransports[0]!;
const webhookEntry = bundle.webhooks[0]!;

const KIND = entry['kind'] as SendProviderKind;

/**
 * EVERY VARIABLE NAME IS READ OFF THE COMPOSED BUNDLE, never spelled. The
 * template derives them from the plugin id, so spelling them here would pin this
 * suite to one generator revision and quietly stop measuring the next.
 *
 * THE TWO SCOPES ARE READ FROM DIFFERENT PLACES, because they mean different
 * things and the composition folds one into the other. The MANIFEST's transport
 * contribution carries what one INSTANCE needs (the names that take an
 * `__<INSTANCEKEY>` suffix); the plugin's `flag` carries the deployment-wide
 * gate; and the composed ENTRY's `requiredEnvVars` is the union of both — the
 * presence list `providerKindConfigured` answers from. Reading the instance
 * credential off the entry would hand a domain-identity module the enablement
 * switch as its API key.
 */
const manifest = (bundle.roster[0]! as unknown as Record<string, unknown>)['manifest'] as Record<
	string,
	unknown
>;
const contribution = (
	(manifest['contributes'] as Record<string, unknown>)['sendTransports'] as readonly Record<
		string,
		unknown
	>[]
)[0]!;
const INSTANCE_REQUIRED_ENV = contribution['requiredEnvVars'] as readonly string[];
const INSTANCE_OPTIONAL_ENV = contribution['optionalEnvVars'] as readonly string[];
/** The plugin's deployment-wide gate, as the composed roster carries it. */
const FLAG_ENV = manifest['flag'] as { readonly requiredEnvVars: readonly string[] };

const SIGNATURE = webhookEntry['signature'] as ConformanceSignatureContract;
const WEBHOOK_SECRET = 'whsec-scaffolded';

/** The transport's own credential — the value a send must go out on. */
const DEFAULT_CREDENTIAL = 'default-instance-key';

/** Everything a real deployment would set for this bundle. */
const CONFIGURED: Readonly<Record<string, string>> = Object.freeze({
	...Object.fromEntries(FLAG_ENV.requiredEnvVars.map((name) => [name, 'set'])),
	[SIGNATURE.secretEnvVar]: WEBHOOK_SECRET,
	...Object.fromEntries(INSTANCE_REQUIRED_ENV.map((name) => [name, DEFAULT_CREDENTIAL])),
});

/** The instance configuration the identity module is handed, as the host builds it. */
const IDENTITY_CONFIG = {
	instanceKey: null,
	env: Object.fromEntries(INSTANCE_REQUIRED_ENV.map((name) => [name, DEFAULT_CREDENTIAL])),
};

/**
 * Make the emitted modules' one network call answer a given way.
 *
 * The mock is kept, because it IS this subject's attempt log: the emitted module
 * really calls `fetch`, so what it was handed can only be read back off the
 * request it made. (The Mock ESP records an attempt list inside its module
 * instead — the one difference the shared conformance body does not need to know
 * about, which is why arranging and observing a send is a subject-supplied pair.)
 */
let lastFetch: ReturnType<typeof vi.fn> | undefined;

function stubFetch(response: Partial<Response> & { readonly json?: () => Promise<unknown> }) {
	const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => response as Response);
	lastFetch = fetchMock;
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

/** The request bodies the emitted send module put on the wire, parsed. */
function sentRequests(): readonly {
	readonly headers: Record<string, string>;
	readonly body: Record<string, unknown>;
}[] {
	return (lastFetch?.mock.calls ?? []).map((call) => {
		const init = call[1] as RequestInit | undefined;
		return {
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
		};
	});
}

const NOW = Date.now();

afterAll(async () => {
	await cleanupScaffoldedBundle();
});

/**
 * THE HOST'S RULES, RUN AGAINST THE GENERATOR'S OUTPUT.
 *
 * Every subject-specific value handed over is read off the composed artifact
 * rather than spelled, so a template that renames anything is still measured
 * against what it now declares. The wire shapes below are written from the
 * emitted webhook module's own declared event kinds; an author who renames
 * `hard_bounce` renames it in one place and this follows.
 *
 * THE UNCONSUMED EVENT CARRIES NO TIMESTAMP, deliberately. Engagement events
 * Owlat does not act on routinely name their time field differently or omit it,
 * and a module that validated the timestamp before deciding the kind would 400
 * the whole batch — taking the four facts beside it down and leaving the provider
 * redelivering forever.
 */
describeSendProviderConformance({
	kind: KIND,
	pluginId: SCAFFOLDED_PLUGIN_ID,
	entry,
	instanceRequiredEnv: INSTANCE_REQUIRED_ENV,
	instanceOptionalEnv: INSTANCE_OPTIONAL_ENV,
	flagRequiredEnv: FLAG_ENV.requiredEnvVars,
	signature: SIGNATURE,
	webhookSecretValue: WEBHOOK_SECRET,
	// THIS SUBJECT'S "NETWORK": the emitted module's real `fetch`, stubbed. The
	// credential is read back out of the `authorization` header it sent and the
	// optional value out of the request body — never out of the configuration it
	// was handed, which is the whole point: a module reading `process.env` is given
	// the right values and sends with the wrong ones.
	send: {
		arrange: () => {
			stubFetch({ ok: true, status: 200, json: async () => ({ id: 'msg-1' }) });
		},
		attempts: () =>
			sentRequests().map((request) => ({
				credential: request.headers['authorization']?.replace(/^Bearer /, ''),
				optional: request.body['region'] as string | undefined,
			})),
	},
	feedbackBatch: {
		body: JSON.stringify({
			events: [
				{ type: 'delivered', message_id: 'm1', timestamp: NOW - 4, recipient: 'a@example.com' },
				{ type: 'hard_bounce', message_id: 'm2', timestamp: NOW - 3, reason: '550 no such user' },
				{ type: 'complaint', timestamp: NOW - 2, recipient: 'c@example.com' },
				{ type: 'deferred', message_id: 'm4', timestamp: NOW - 1, reason: '451 try later' },
				{ type: 'opened', message_id: 'm5' },
			],
		}),
		kinds: ['email.delivered', 'email.bounced', 'email.complained', 'email.deferred'],
	},
	domainScenarios: {
		verified: () => {
			stubFetch({
				ok: true,
				status: 200,
				json: async () => ({ verified: true, spf_valid: true, dkim_valid: true }),
			});
			return { domain: 'sender.example.com', config: IDENTITY_CONFIG };
		},
		// The provider confirms ownership but the customer's DKIM record is not
		// published: observations the host must NOT derive `verified` from.
		unverified: () => {
			stubFetch({
				ok: true,
				status: 200,
				json: async () => ({ verified: true, spf_valid: true, dkim_valid: false }),
			});
			return { domain: 'pending.example.com', config: IDENTITY_CONFIG };
		},
		authFailed: () => {
			stubFetch({ ok: false, status: 401 });
			return { domain: 'a.example.com', config: IDENTITY_CONFIG };
		},
	},
});

describe('the emitted bundle composes to the kind its two identifiers imply', () => {
	// The generator builds this string through the grammar's one builder, and the
	// authoring guide's `create` command is what produces the two identifiers it is
	// built from — so a template that changed either has to fail here.
	it('composes to the kind the plugin id and the transport local id imply', () => {
		expect(KIND).toBe(`plugin.${SCAFFOLDED_PLUGIN_ID}.relay`);
		expect(entry['pluginId']).toBe(SCAFFOLDED_PLUGIN_ID);
	});

	// The template's own capability choice, which the tier permits either way and
	// the shared body therefore does not pin: the emitted send returns the
	// provider's id, and every feedback event is joined on it.
	it('declares the message-id source the emitted send module actually returns', () => {
		expect(entry['messageIdSource']).toBe('provider');
	});
});

describe('a send actually goes out through the emitted send module', () => {
	/*
	 * INSTANCE RESOLUTION, THE GRANT RECHECK AND THE TWO FAIL-CLOSED REFUSALS ARE
	 * NOT HERE. They are the HOST's rules and they run over this subject in
	 * `../sendProviderConformance`, through the `send` harness declared above —
	 * the same body, the same cases, over P3.3's hand-written fixture too. What is
	 * left below is what only the EMITTED MODULE can be asked: the status mapping
	 * it ships, measured in the retry budget the host spends because of it.
	 */

	/** The governed entry point's context: authorization recheck + audit sink. */
	function fakeContext(isAuthorized = true) {
		return {
			runMutation: vi.fn(async () => isAuthorized),
			scheduler: { runAfter: vi.fn(async () => undefined) },
		};
	}

	const message = {
		to: 'recipient@example.com',
		from: 'sender@example.com',
		subject: 'Conformance',
		html: '<p>Conformance</p>',
	};

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	/**
	 * THE RETRY SEMANTICS THE TEMPLATE SHIPS. This is the part of a provider
	 * integration that is the same for every vendor and the part an author is most
	 * likely to get wrong, so the emitted mapping is pinned at the GOVERNED
	 * boundary: a 429 and a 408 must come back retryable and a 400 must not. The
	 * ATTEMPT COUNT is what makes it an assertion about the host's behaviour rather
	 * than about a returned string — a code the loop does not treat as retryable
	 * spends one attempt whatever it is called.
	 */
	it.each([
		// A rate limit is retryable, so the loop spends the entry's whole
		// `retryDelays` budget: one attempt per delay plus the first.
		[429, EmailErrorCode.RATE_LIMIT, (entry['retryDelays'] as readonly number[]).length + 1],
		// The other retryable 4xx, and the one a hand-written mapping usually files
		// as terminal: a request that timed out may well succeed on the retry.
		[408, EmailErrorCode.SERVER_ERROR, (entry['retryDelays'] as readonly number[]).length + 1],
		// A rejection is terminal: retrying it would burn the budget on a send that
		// can never succeed.
		[400, EmailErrorCode.CONTENT_REJECTED, 1],
	])('maps a provider %s onto the host vocabulary', async (status, errorCode, attempts) => {
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);
		stubFetch({ ok: false, status });

		const result = await sendProviderDispatch(fakeContext() as never, KIND, message);

		expect(result.result).toMatchObject({ success: false, errorCode });
		expect(result.attempts).toBe(attempts);
	});
});

/**
 * THE STUBS THE TEMPLATE SHIPS, RUN AS SHIPPED.
 *
 * Everything above drives the emitted MODULES. The emitted `src/__tests__` are
 * the other half of what an author receives — the first thing they run, and the
 * files that tell them what each half is supposed to hold — and nothing else in
 * this repository executes them: a renamed export or a changed `send` signature
 * would leave four stale suites behind, with the generator's own tests, this gate
 * and the emitted modules all green. So they are run here, in a child process,
 * through the package's own emitted `vitest.config.ts`, exactly as `bun run test`
 * inside a freshly scaffolded package would.
 */
describe("the emitted package's own suite passes as emitted", () => {
	/** Every test file the generator wrote, so "all of them ran" is derived. */
	const emittedSuites = [...bundle.files.keys()].filter((path) => path.endsWith('.test.ts'));

	it('runs every emitted test file green, unmodified', async () => {
		const { spawnSync } = await import('node:child_process');
		const { REPOSITORY_ROOT } = await import('../repository');
		const { readFile, rm } = await import('node:fs/promises');
		const { join, relative, sep } = await import('node:path');
		const { tmpdir } = await import('node:os');

		expect(emittedSuites.length).toBeGreaterThan(3);
		const report = join(tmpdir(), `owlat-scaffolded-suite-${process.pid}.json`);
		// The child must not inherit this run's Vitest wiring, or it reports into
		// the parent's pool instead of running its own.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST'))
		);
		const result = spawnSync(
			process.execPath,
			[
				join(REPOSITORY_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
				'run',
				// TWO REPORTERS ON PURPOSE. The JSON one is what this suite reads back;
				// the default one is what a HUMAN reads, because the assertion below
				// prints the child's stdout — and a failing stub whose name never
				// reached the parent would be reported as "the emitted suite failed"
				// and nothing more.
				'--reporter=default',
				'--reporter=json',
				`--outputFile.json=${report}`,
			],
			{ cwd: bundle.directory, encoding: 'utf8', env }
		);

		try {
			expect(
				result.status,
				`${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(bundle.directory, '<scaffold>')
			).toBe(0);
			// The exit status alone would also be 0 for a run that collected nothing,
			// so the report is read back and the FILES are compared: every emitted
			// suite ran (a stub the config's include glob missed would be silently
			// absent), every case in them passed, none failed.
			const summary = JSON.parse(await readFile(report, 'utf8')) as {
				readonly testResults: readonly { readonly name: string }[];
				readonly numPassedTests: number;
				readonly numFailedTests: number;
			};
			const ran = summary.testResults
				.map((file) => relative(bundle.directory, file.name).split(sep).join('/'))
				.sort();
			expect(ran).toEqual([...emittedSuites].sort());
			expect(summary.numFailedTests).toBe(0);
			expect(summary.numPassedTests).toBeGreaterThan(0);
		} finally {
			await rm(report, { force: true });
		}
	});
});

describe('none of it required an edit', () => {
	/**
	 * THE HEADLINE CLAIM, ASSERTED. Everything above ran against files this suite
	 * did not write by hand — but "did not write by hand" is only worth the
	 * assertion if the materialised directory still holds exactly what the
	 * generator produced. The fixture writes `buildScaffold`'s output and keeps the
	 * map; this reads every file back off disk and compares it byte for byte, so a
	 * fixture that patched a TODO to make a case pass fails here.
	 */
	it('drove the generator output byte for byte, with nothing patched', async () => {
		const { readFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		expect(bundle.files.size).toBeGreaterThan(0);
		for (const [path, content] of bundle.files) {
			const onDisk = await readFile(join(bundle.directory, ...path.split('/')), 'utf8');
			expect(onDisk, `${path} differs from what the generator emitted`).toBe(content);
		}
	});

	/**
	 * And no production file knows this bundle exists. The scaffolded package is
	 * written to a temporary directory and named after a stranger's scope, so a
	 * hit under `apps/` or `packages/` would mean a core module had been taught
	 * about it — the one thing D4's policy forbids.
	 *
	 * TWO TEST FILES ARE EXEMPT AND NAMED, each for its own reason.
	 */
	const ALLOWED_TEST_FILES = [
		// The generator's own suite scaffolds under the same identity — the same
		// fixture, deliberately, so renaming it in one place fails in the other.
		'packages/plugin-cli/src/__tests__/scaffoldSendProvider.test.ts',
		// The compiled manifest sample the guide quotes verbatim, which declares the
		// same id the guide's `create` command scaffolds. A sample declaring a
		// different one would show a reader a manifest that is not the one the
		// command they just ran produced.
		'packages/plugin-kit/src/__tests__/docsSamples.test.ts',
	].sort();

	/**
	 * PROSE IS EXCLUDED, and only prose. The authoring guide tells an author to run
	 * `create` under exactly this identity, which is the point rather than a leak —
	 * a documented command nothing exercises is how a scaffold rots. The binding
	 * between the two is asserted in its own case below rather than being lost in
	 * an exemption list.
	 */
	const PROSE = '*.md';

	it('leaves every non-test source file under apps/ and packages/ ignorant of it', () => {
		const hits = repositoryFilesMentioning(
			[SCAFFOLDED_PACKAGE_NAME, `plugin.${SCAFFOLDED_PLUGIN_ID}.relay`],
			{ exclude: [PROSE] }
		);
		expect(hits.filter((path) => !path.includes('/__tests__/'))).toEqual([]);
		expect([...hits].sort()).toEqual(ALLOWED_TEST_FILES);
	});

	/**
	 * THE COMMAND THE GUIDE PRINTS IS THE COMMAND THIS GATE PROVES.
	 *
	 * The authoring page opens with an `owlat plugins create` invocation, and a
	 * reader will run it verbatim. Binding it here means the identity this suite
	 * drives through routing, dispatch, feedback and identity is the identity that
	 * invocation produces — so a guide edited to show a different id or package
	 * fails rather than shipping a command nothing has exercised.
	 */
	it('is the identity the authoring guide tells an author to scaffold', async () => {
		const { readRepositoryFile } = await import('../repository');
		const guide = await readRepositoryFile(
			'apps/docs/content/en/3.developer/49.plugin-send-providers.md'
		);
		const command = /owlat plugins create ([\w-]+) --name (\S+) --template (\S+)/.exec(guide);
		expect(command, 'the guide no longer prints a create invocation').not.toBeNull();
		expect(command![1]).toBe(SCAFFOLDED_PLUGIN_ID);
		expect(command![2]).toBe(SCAFFOLDED_PACKAGE_NAME);
		expect(command![3]).toBe('send-provider');
	});

	/**
	 * AND THE SAMPLE THE GUIDE SHOWS IS THE BUNDLE THE COMMAND EMITS.
	 *
	 * The page's centrepiece manifest is the one thing a reader diffs against their
	 * freshly scaffolded package, so every name it declares must be a name this
	 * bundle actually has. The sample lives in `docsSamples.test.ts` (it is
	 * compiled and executed there) and the guide quotes it verbatim, which is why
	 * the assertion reads the compiled source rather than the page.
	 */
	it('shows a manifest sample declaring the variables this bundle composes', async () => {
		const { readRepositoryFile } = await import('../repository');
		const sample = await readRepositoryFile(
			'packages/plugin-kit/src/__tests__/docsSamples.test.ts'
		);
		const region = sample.slice(
			sample.indexOf('// #region send-provider-manifest'),
			sample.indexOf('// #endregion send-provider-manifest')
		);
		expect(region.length).toBeGreaterThan(0);
		for (const name of [
			...INSTANCE_REQUIRED_ENV,
			...INSTANCE_OPTIONAL_ENV,
			...FLAG_ENV.requiredEnvVars,
		]) {
			expect(region, `the guide's sample no longer declares ${name}`).toContain(`'${name}'`);
		}
		expect(region).toContain(`'${SIGNATURE.header}'`);
		expect(region).toContain(`'${SIGNATURE.replay.timestampHeader}'`);
	});
});
