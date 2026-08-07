/**
 * The `send-provider` template's TEST STUBS and README, as emitted source.
 *
 * Split out of `./scaffoldSendProvider` at the repository's ~500 LOC ratchet.
 * These are the files an author RUNS rather than ships: one suite per half,
 * each pinning the property that half exists to hold — the manifest's two
 * variable scopes, the send module's credential source and status mapping, the
 * webhook's four feedback facts, and the identity module's three distinguishable
 * outcomes. A template whose stubs asserted only that the module was defined
 * would teach an author to test the wrong thing.
 *
 * EVERY EMITTED SUITE IMPORTS ITS SUBJECT UNDER A SHORT LOCAL ALIAS
 * (`acmeRelayTransport as transport`). The exported names are derived from the
 * plugin id and are the package's real surface, but a body that repeated them
 * would be a body whose line widths grew with the id — and `create` scaffolds
 * into this workspace, where an author's first `bun run lint` runs the repository
 * formatter over what was just written. `scaffoldSendProvider.test.ts` runs the
 * real `oxfmt --check` over this generator's output to keep that true.
 */

import type { PluginPackageName } from '@owlat/plugin-host';
import type { SendProviderNames } from './scaffoldSendProvider';
import { SEND_PROVIDER_ENV_CONSTANTS, sendProviderEnvVars } from './scaffoldSendProvider';

export function manifestTestSource(names: SendProviderNames): string {
	const c = SEND_PROVIDER_ENV_CONSTANTS;
	return `import { parsePluginManifest } from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import { ${names.camel}Plugin as plugin } from '../manifest';
import { ${c.apiKey}, ${c.webhookSecret} } from '../envNames';

const transport = plugin.contributes.sendTransports[0];

describe('${names.id} manifest', () => {
	it('is a valid plugin manifest declaring the ${names.id} id', () => {
		expect(parsePluginManifest(plugin).id).toBe('${names.id}');
	});

	it('declares all three halves of the send-provider bundle', () => {
		expect(transport.module.exportPath).toBe('./convex/transport');
		// Declaring these two IS the catalog's hasProviderFeedback / 'api'
		// domainVerification for this kind, so dropping one drops a promise.
		expect(transport.webhook.module.exportPath).toBe('./convex/webhook');
		expect(transport.domainIdentity.module.exportPath).toBe('./convex/domainIdentity');
	});

	it('keeps the plugin gate and the transport credential in separate scopes', () => {
		// The signing secret gates the whole plugin (an unset one refuses every
		// delivery); the API key is the transport's own per-instance credential.
		expect(plugin.flag.requiredEnvVars).toContain(${c.webhookSecret});
		expect(transport.requiredEnvVars).toEqual([${c.apiKey}]);
	});

	it('asks only for variables this transport reads, in the matching list', () => {
		const required = new Set<string>(transport.requiredEnvVars);
		const optional = new Set<string>(transport.optionalEnvVars);
		for (const field of transport.credentialFields) {
			// \`required\` is optional on the descriptor union, so the narrowing is
			// explicit: an absent one means the field writes an OPTIONAL variable.
			const isRequired = 'required' in field && field.required === true;
			expect(isRequired ? required.has(field.envVar) : optional.has(field.envVar)).toBe(true);
		}
	});
});
`;
}

export function transportTestSource(names: SendProviderNames): string {
	const c = SEND_PROVIDER_ENV_CONSTANTS;
	return `import { afterEach, describe, expect, it, vi } from 'vitest';
import { ${names.camel}Transport as transport } from '../convex/transport';
import { ${c.apiKey} } from '../envNames';

/** The instance-resolved configuration the host hands \`send\`. */
const config = { instanceKey: null, env: { [${c.apiKey}]: 'test-key' } };

const message = {
	to: 'recipient@example.com',
	from: 'sender@example.com',
	subject: 'Hello',
	html: '<p>Hello</p>',
};

function stubFetch(response: Partial<Response> & { readonly json?: () => Promise<unknown> }) {
	// The parameters are declared so the mock's recorded calls stay typed: a
	// zero-argument \`vi.fn\` records an empty tuple and the assertion below could
	// not read the request back.
	const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => response as Response);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('${names.id} send', () => {
	it('reads its credential from the instance configuration, never the environment', async () => {
		const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ id: 'msg-1' }) });
		expect(await transport.send(message, {}, config)).toEqual({ success: true, id: 'msg-1' });
		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit | undefined)?.headers as
			| Record<string, string>
			| undefined;
		expect(headers?.['authorization']).toBe('Bearer test-key');
	});

	it('reports a rate limit as retryable and a rejection as terminal', async () => {
		stubFetch({ ok: false, status: 429 });
		expect(await transport.send(message, {}, config)).toEqual({
			success: false,
			code: 'rate_limited',
		});
		// The other retryable 4xx: a timed-out request is transient, and reading it
		// as terminal drops a message a retry would have delivered.
		stubFetch({ ok: false, status: 408 });
		expect(await transport.send(message, {}, config)).toEqual({
			success: false,
			code: 'temporary_failure',
		});
		stubFetch({ ok: false, status: 400 });
		expect(await transport.send(message, {}, config)).toEqual({
			success: false,
			code: 'content_rejected',
		});
	});

	it('refuses extras it does not recognise rather than coercing them', () => {
		expect(transport.parseExtras(undefined)).toEqual({});
		expect(() => transport.parseExtras({ campaignTag: 7 })).toThrow(TypeError);
	});
});
`;
}

export function webhookTestSource(names: SendProviderNames): string {
	return `import { describe, expect, it } from 'vitest';
import { ${names.camel}Webhook as webhook } from '../convex/webhook';

/** The wire timestamp. Epoch MILLISECONDS is what the host accepts. */
const at = Date.now();

describe('${names.id} feedback parsing', () => {
	it('turns the provider wire shape into the four feedback facts', () => {
		const events = webhook.parseEvents(
			JSON.stringify({
				events: [
					{ type: 'delivered', message_id: 'm1', timestamp: at, recipient: 'a@example.com' },
					{ type: 'hard_bounce', message_id: 'm2', timestamp: at, reason: '550 no such user' },
					{ type: 'complaint', timestamp: at, recipient: 'c@example.com' },
					{ type: 'deferred', message_id: 'm4', timestamp: at, reason: '451 try later' },
				],
			})
		);
		expect(events.map((event) => event.kind)).toEqual([
			'delivered',
			'bounced',
			'complained',
			'deferred',
		]);
		// THE UNITS, PINNED. The host bounds \`at\` against the wall clock in epoch
		// MILLISECONDS and fails the whole batch outside that window, so a provider
		// reporting seconds must be converted in \`readAt\` — and this case is what
		// tells you, rather than a 400 on every delivery once the endpoint is live.
		expect(events.map((event) => event.at)).toEqual([at, at, at, at]);
		for (const event of events) expect(Math.abs(event.at - Date.now())).toBeLessThan(60_000);
	});

	it('acknowledges a console ping and an event kind it does not consume', () => {
		expect(webhook.parseEvents(JSON.stringify({}))).toEqual([]);
		// NO TIMESTAMP ON THE UNCONSUMED EVENT, deliberately: an engagement event
		// Owlat ignores routinely names its time field differently or omits it, and
		// this batch must still be acknowledged rather than 400-ed and redelivered
		// forever.
		const ignored = JSON.stringify({ events: [{ type: 'opened', message_id: 'm5' }] });
		expect(webhook.parseEvents(ignored)).toEqual([]);
	});

	it('throws on a body it cannot read', () => {
		expect(() => webhook.parseEvents('not json')).toThrow(TypeError);
	});

	it('refuses a complaint that names neither a message nor a recipient', () => {
		// The host refuses it too, for the whole batch — this says so in the module's
		// own words, at the boundary that understands the wire shape.
		const anonymous = JSON.stringify({ events: [{ type: 'complaint', timestamp: at }] });
		expect(() => webhook.parseEvents(anonymous)).toThrow(TypeError);
	});
});
`;
}

export function domainIdentityTestSource(names: SendProviderNames): string {
	const c = SEND_PROVIDER_ENV_CONSTANTS;
	return `import { afterEach, describe, expect, it, vi } from 'vitest';
import { ${names.camel}DomainIdentity as identity } from '../convex/domainIdentity';
import { ${c.apiKey} } from '../envNames';

const config = { instanceKey: null, env: { [${c.apiKey}]: 'test-key' } };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('${names.id} sending-domain identity', () => {
	it('reports observations rather than a verdict', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ verified: true, spf_valid: true, dkim_valid: true }),
			}))
		);
		const result = await identity.checkDomain('sender.example.com', config);
		expect(result.outcome).toBe('ok');
		expect(result.outcome === 'ok' && result.state.isOwnershipVerified).toBe(true);
		// There is no \`status\` to return: the host derives it.
		expect('status' in (result.outcome === 'ok' ? result.state : {})).toBe(false);
	});

	it('distinguishes a rejected credential from an outage', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 401 }))
		);
		expect((await identity.checkDomain('a.example.com', config)).outcome).toBe('auth_failed');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 503 }))
		);
		expect((await identity.checkDomain('a.example.com', config)).outcome).toBe('unavailable');
	});

	it('fails closed when this instance has no credential', async () => {
		const unconfigured = { instanceKey: 'eu', env: {} };
		expect((await identity.checkDomain('a.example.com', unconfigured)).outcome).toBe('auth_failed');
	});
});
`;
}

export function readmeSource(names: SendProviderNames, packageName: PluginPackageName): string {
	const env = sendProviderEnvVars(names);
	return `# ${packageName}

The \`${names.id}\` Owlat **send provider** — one package carrying a provider's
send path, feedback webhook, sending-domain identity, capability declarations and
credential form. The composed transport kind is
\`${names.kind}\`.

The full contract, the two-tier provider checklist and the webhook security
model are documented at **/developer/plugin-send-providers**.

## What is already done

- \`src/manifest.ts\` — the data-only declaration: capabilities, credential form,
  signature contract
- \`src/envNames.ts\` — every environment variable name, declared once
- \`src/convex/transport.ts\` — the send path: one network attempt, typed outcomes
- \`src/convex/webhook.ts\` — the feedback path: parse only; the host verifies
- \`src/convex/domainIdentity.ts\` — the sending-domain identity: observations only

## What is left for you

Every remaining decision is marked \`TODO\` at the line it belongs on:

1. the endpoints and request/response shapes in \`src/convex/transport.ts\` and
   \`src/convex/domainIdentity.ts\`;
2. the event kinds your provider sends, in \`src/convex/webhook.ts\`;
3. the signature headers and DKIM/SPF facts in \`src/manifest.ts\` and
   \`src/convex/domainIdentity.ts\`;
4. the operator copy on the credential fields.

Nothing outside this package needs editing. Routing, dispatch, retries, the
deliverability fallback, the ramp controller's arm attribution and the credential
form all read what the manifest declares.

## Environment

- \`${env.enabled}\` — plugin-wide: enables the plugin
- \`${env.webhookSecret}\` — plugin-wide: the host verifies feedback deliveries with it
- \`${env.apiKey}\` — per transport instance (\`${env.apiKey}__EU\` for \`#eu\`)
- \`${env.region}\` — per transport instance, optional

## Development

\`\`\`sh
bun run --cwd <path-to-this-package> typecheck
bun run --cwd <path-to-this-package> lint
bun run --cwd <path-to-this-package> test
\`\`\`

## Publishing it as your own package

\`create\` scaffolded this INSIDE an Owlat checkout, so the package is \`private\`
and wired to that checkout: \`workspace:*\` and \`catalog:\` specifiers, a
\`tsconfig.json\` that extends the repository's base config, and a \`lint\` script
pointing at its oxlint config. Publishing without undoing that would ship a
package nobody can install, so it is one step of moving out rather than a step on
its own:

1. move this directory out of the Owlat checkout;
2. delete \`"private": true\` from \`package.json\`;
3. replace the \`workspace:*\` and \`catalog:\` specifiers with real version ranges,
   and point \`tsconfig.json\`, \`vitest.config.ts\` and the \`lint\` script at your own
   configuration;
4. publish it.

To then bundle this provider into a deployment, add its package name to that
deployment's \`plugins.config.ts\` with \`owlat plugins add ${packageName}\` and
regenerate the composition with \`owlat plugins codegen\`.
`;
}
