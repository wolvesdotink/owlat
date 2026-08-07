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
 */

import type { PluginPackageName } from '@owlat/plugin-host';
import type { SendProviderNames } from './scaffoldSendProvider';
import { sendProviderEnvVars } from './scaffoldSendProvider';

export function manifestTestSource(names: SendProviderNames): string {
	const env = sendProviderEnvVars(names);
	return `import { parsePluginManifest } from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import { ${names.camel}Plugin } from '../manifest';
import { ${env.apiKey}_ENV, ${env.webhookSecret}_ENV } from '../envNames';

describe('${names.id} manifest', () => {
	it('is a valid plugin manifest declaring the ${names.id} id', () => {
		expect(parsePluginManifest(${names.camel}Plugin).id).toBe('${names.id}');
	});

	it('declares all three halves of the send-provider bundle', () => {
		const transport = ${names.camel}Plugin.contributes.sendTransports[0];
		expect(transport.module.exportPath).toBe('./convex/transport');
		// Declaring these two IS the catalog's hasProviderFeedback / 'api'
		// domainVerification for this kind, so dropping one drops a promise.
		expect(transport.webhook.module.exportPath).toBe('./convex/webhook');
		expect(transport.domainIdentity.module.exportPath).toBe('./convex/domainIdentity');
	});

	it('keeps the plugin gate and the transport credential in separate scopes', () => {
		// The signing secret gates the whole plugin (an unset one refuses every
		// delivery); the API key is the transport's own per-instance credential.
		expect(${names.camel}Plugin.flag.requiredEnvVars).toContain(${env.webhookSecret}_ENV);
		expect(${names.camel}Plugin.contributes.sendTransports[0].requiredEnvVars).toEqual([
			${env.apiKey}_ENV,
		]);
	});

	it('asks only for variables this transport reads, in the matching list', () => {
		const transport = ${names.camel}Plugin.contributes.sendTransports[0];
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
	const env = sendProviderEnvVars(names);
	return `import { afterEach, describe, expect, it, vi } from 'vitest';
import { ${names.camel}Transport } from '../convex/transport';
import { ${env.apiKey}_ENV } from '../envNames';

/** The instance-resolved configuration the host hands \`send\`. */
const config = { instanceKey: null, env: { [${env.apiKey}_ENV]: 'test-key' } };

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
		expect(await ${names.camel}Transport.send(message, {}, config)).toEqual({
			success: true,
			id: 'msg-1',
		});
		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit | undefined)?.headers as
			| Record<string, string>
			| undefined;
		expect(headers?.['authorization']).toBe('Bearer test-key');
	});

	it('reports a rate limit as retryable and a rejection as terminal', async () => {
		stubFetch({ ok: false, status: 429 });
		expect(await ${names.camel}Transport.send(message, {}, config)).toEqual({
			success: false,
			code: 'rate_limited',
		});
		stubFetch({ ok: false, status: 400 });
		expect(await ${names.camel}Transport.send(message, {}, config)).toEqual({
			success: false,
			code: 'content_rejected',
		});
	});

	it('refuses extras it does not recognise rather than coercing them', () => {
		expect(${names.camel}Transport.parseExtras(undefined)).toEqual({});
		expect(() => ${names.camel}Transport.parseExtras({ campaignTag: 7 })).toThrow(TypeError);
	});
});
`;
}

export function webhookTestSource(names: SendProviderNames): string {
	return `import { describe, expect, it } from 'vitest';
import { ${names.camel}Webhook } from '../convex/webhook';

const at = Date.now();

describe('${names.id} feedback parsing', () => {
	it('turns the provider wire shape into the four feedback facts', () => {
		const events = ${names.camel}Webhook.parseEvents(
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
	});

	it('acknowledges a console ping and an event kind it does not consume', () => {
		expect(${names.camel}Webhook.parseEvents(JSON.stringify({}))).toEqual([]);
		expect(
			${names.camel}Webhook.parseEvents(
				JSON.stringify({ events: [{ type: 'opened', message_id: 'm5', timestamp: at }] })
			)
		).toEqual([]);
	});

	it('throws on a body it cannot read', () => {
		expect(() => ${names.camel}Webhook.parseEvents('not json')).toThrow(TypeError);
	});
});
`;
}

export function domainIdentityTestSource(names: SendProviderNames): string {
	const env = sendProviderEnvVars(names);
	return `import { afterEach, describe, expect, it, vi } from 'vitest';
import { ${names.camel}DomainIdentity } from '../convex/domainIdentity';
import { ${env.apiKey}_ENV } from '../envNames';

const config = { instanceKey: null, env: { [${env.apiKey}_ENV]: 'test-key' } };

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
		const result = await ${names.camel}DomainIdentity.checkDomain('sender.example.com', config);
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
		expect((await ${names.camel}DomainIdentity.checkDomain('a.example.com', config)).outcome).toBe(
			'auth_failed'
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 503 }))
		);
		expect((await ${names.camel}DomainIdentity.checkDomain('a.example.com', config)).outcome).toBe(
			'unavailable'
		);
	});

	it('fails closed when this instance has no credential', async () => {
		expect(
			(await ${names.camel}DomainIdentity.checkDomain('a.example.com', { instanceKey: 'eu', env: {} }))
				.outcome
		).toBe('auth_failed');
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

To bundle this provider into a deployment, publish it and add its package name to
the workspace \`plugins.config.ts\` with \`owlat plugins add ${packageName}\`, then
regenerate the composition with \`owlat plugins codegen\`.
`;
}
