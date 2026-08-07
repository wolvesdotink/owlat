/**
 * WHAT COMES BACK, as the host decides it — the other half of the send-provider
 * conformance body (see `./sendProviderConformance`).
 *
 * The feedback route's registration, the verify → parse → revalidate chain, the
 * sending-domain identity split between the module's observations and the host's
 * derived status, and the credential form's vocabulary and join. Its sibling
 * `./sendProviderConformanceSendPath` holds everything on the way out.
 */

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginSendTransportWebhookFor } from '@owlat/api/plugins/sendTransportWebhookCatalog';
import { pluginSendTransportDomainIdentityFor } from '@owlat/api/plugins/sendTransportDomainIdentityCatalog';
import { verifyPluginReplayBoundSignature } from '@owlat/api/plugins/inboundSignature';
import { parsePluginFeedbackEvents } from '@owlat/api/webhooks/pluginFeedbackEvents';
import { parsePluginRelayResult } from '@owlat/api/domains/pluginRelayState';
import { SEND_PROVIDER_CREDENTIAL_FIELD_KINDS } from '@owlat/shared/sendProviderCatalog';
import type { SendProviderConformanceSubject } from './sendProviderConformanceSubject';

export function describeFeedbackConformance(subject: SendProviderConformanceSubject): void {
	const KIND = subject.kind;
	const entry = subject.entry;

	describe('its feedback arrives on the plugin webhook route', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		// The route is keyed by PLUGIN ID and resolves before a byte of the body is
		// read; an unknown id is the 404 that keeps unverified traffic away from
		// signature verification entirely.
		it('registers exactly this plugin id, and nothing else', () => {
			expect(pluginSendTransportWebhookFor(subject.pluginId)?.definition).toMatchObject({
				kind: KIND,
				pluginId: subject.pluginId,
				storeRawPayload: false,
			});
			expect(pluginSendTransportWebhookFor('someone-else')).toBeUndefined();
			// Map-backed, so a prototype key resolves to nothing rather than to an
			// inherited member being called as an adapter.
			expect(pluginSendTransportWebhookFor('__proto__')).toBeUndefined();
		});

		/**
		 * THE REPLAY PROVISIONS THE HOST REQUIRES, carried from the manifest through
		 * codegen. A bundle that shipped a body-only HMAC would fail validation; one
		 * that shipped an unbounded tolerance would expose an endpoint a captured
		 * request verifies against forever.
		 */
		it('carries a bounded, replay-bound signature contract', () => {
			expect(subject.signature.algorithm).toBe('hmac-sha256');
			expect(subject.signature.replay.timestampHeader.length).toBeGreaterThan(0);
			expect(subject.signature.replay.toleranceSeconds).toBeGreaterThan(0);
			expect(subject.signature.replay.toleranceSeconds).toBeLessThanOrEqual(900);
		});

		/**
		 * THE WHOLE CHAIN, and THROUGH THE LOOKUP rather than through the module: the
		 * host proves authenticity, the bundle's module turns verified bytes into
		 * feedback facts, and the host re-validates that output and stamps the
		 * transport kind ITSELF — so a plugin cannot attribute a bounce to somebody
		 * else's arm. Calling the module directly would leave a registry that
		 * answered this plugin id with SOMEBODY ELSE's parser perfectly green, which
		 * is the one join this case exists to prove.
		 *
		 * The verifier's negatives — tampered body, forged signature, stale
		 * timestamp, unset secret — are `verifyPluginReplayBoundSignature`'s own
		 * contract and are owned exhaustively by
		 * `apps/api/convex/plugins/__tests__/inboundSignature.test.ts` and
		 * `apps/api/convex/webhooks/__tests__/pluginFeedbackRoute.test.ts`. A third
		 * copy would add no case and one more place to edit.
		 */
		it('verifies, parses and revalidates a signed batch into feedback facts', async () => {
			vi.stubEnv(subject.signature.secretEnvVar, subject.webhookSecretValue);
			const surface = pluginSendTransportWebhookFor(subject.pluginId);
			if (!surface) throw new Error('the subject webhook is not registered');

			const nowMs = Date.now();
			const timestamp = String(Math.floor(nowMs / 1000));
			const body = subject.feedbackBatch.body;
			const verified = await verifyPluginReplayBoundSignature({
				contract: surface.definition.signature,
				pluginId: subject.pluginId,
				transportKind: KIND,
				rawBody: body,
				signature: createHmac('sha256', subject.webhookSecretValue)
					.update(`${timestamp}.${body}`)
					.digest('hex'),
				timestamp,
				nowMs,
			});
			expect(verified.ok).toBe(true);

			// The kind is taken from the RESOLVED REGISTRATION, not from a constant:
			// passing the kind here would reduce the assertion below to "the function
			// stamps what I gave it".
			const events = parsePluginFeedbackEvents(
				surface.module.parseEvents(body),
				surface.definition.kind
			);
			expect(events.map((event) => event.kind)).toEqual(subject.feedbackBatch.kinds);
			expect(
				events.every(
					(event) =>
						'providerType' in event &&
						(event as { readonly providerType?: string }).providerType === KIND
				)
			).toBe(true);
		});
	});

	describe('it proves a sending domain through its identity module', () => {
		/**
		 * THE MODULE THE HOST WOULD CALL, resolved the way the host resolves it — by
		 * NAMESPACED KIND, which is how this registry is keyed (the feedback one is
		 * keyed by plugin id, because its route surface is). Calling an imported
		 * fixture object directly would leave a registry that keyed identities by
		 * `pluginId` perfectly green while the host asked the wrong third party
		 * whether this domain is proven.
		 */
		function identityModule() {
			const surface = pluginSendTransportDomainIdentityFor(KIND);
			if (!surface) throw new Error('the subject domain identity is not registered');
			return surface.module;
		}

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('is registered as a sending-domain identity provider for its own kind', () => {
			expect(pluginSendTransportDomainIdentityFor(KIND)?.definition).toMatchObject({
				kind: KIND,
				pluginId: subject.pluginId,
				requiredEnvVars: subject.instanceRequiredEnv,
			});
		});

		// THE SPLIT: the module reports observations, the HOST derives the status.
		it('derives verified from the observations the module reported', async () => {
			const scenario = subject.domainScenarios.verified();
			const outcome = parsePluginRelayResult(
				await identityModule().registerDomain(scenario.domain, scenario.config)
			);
			expect(outcome.outcome).toBe('ok');
			expect(outcome.outcome === 'ok' ? outcome.observation.status : null).toBe('verified');
			// A selector list is what the ramp's alignment pre-flight resolves; an
			// empty one holds every domain at s=0, so a bundle must ship a real one.
			expect(
				outcome.outcome === 'ok' ? outcome.observation.dkimSelectors.length : 0
			).toBeGreaterThan(0);
		});

		it('reports a domain whose proof is incomplete as anything but verified', async () => {
			const scenario = subject.domainScenarios.unverified();
			const outcome = parsePluginRelayResult(
				await identityModule().checkDomain(scenario.domain, scenario.config)
			);
			expect(outcome.outcome === 'ok' ? outcome.observation.status : null).not.toBe('verified');
		});

		// A credential the provider rejected is TERMINAL and says so — distinguishable
		// from an outage, because the host's write rules differ: only this one
		// condemns a credential, and neither refreshes the proof's age.
		it('reports a rejected credential as auth_failed, not as an outage', async () => {
			const scenario = subject.domainScenarios.authFailed();
			expect(
				parsePluginRelayResult(await identityModule().checkDomain(scenario.domain, scenario.config))
					.outcome
			).toBe('auth_failed');
		});

		// Untrusted output is untrusted output: a shape the host does not recognise is
		// `unavailable` — evidence of nothing — never a verdict that could mark a
		// domain unverified while refreshing the freshness clock.
		it('reads a malformed module answer as unavailable', () => {
			expect(parsePluginRelayResult({ outcome: 'ok' }).outcome).toBe('unavailable');
		});
	});

	describe('its credential form is one the shared UI vocabulary can draw', () => {
		const fields = entry['credentialFields'] as readonly Record<string, unknown>[];

		it('declares its form in the shared field vocabulary', () => {
			expect(fields.length).toBeGreaterThan(0);
			for (const field of fields) {
				expect(SEND_PROVIDER_CREDENTIAL_FIELD_KINDS).toContain(field['kind']);
			}
		});

		/**
		 * THE JOIN THAT MAKES A FORM HONEST: every variable the form writes is one
		 * the transport reads, in the list matching the field's own `required`. A
		 * form asking for a variable no send reads is an operator filling in nothing;
		 * one omitting a gating variable is a transport that stays unconfigured
		 * behind a complete-looking form.
		 */
		it('asks only for variables this transport reads, in the matching list', () => {
			const required = new Set(subject.instanceRequiredEnv);
			const optional = new Set(subject.instanceOptionalEnv);
			for (const field of fields) {
				const envVar = field['envVar'] as string;
				expect(field['required'] === true ? required.has(envVar) : optional.has(envVar)).toBe(true);
			}
			// Every required variable is askable, or an operator cannot configure the
			// transport from the form at all.
			for (const name of subject.instanceRequiredEnv) {
				expect(fields.some((field) => field['envVar'] === name)).toBe(true);
			}
		});

		// The renderer keys its form state by ENV VARIABLE and never renders a
		// `secret` back, so the descriptor is what tells a surface which value is
		// write-only.
		it('marks the credential itself write-only', () => {
			const secret = fields.find((field) => field['envVar'] === subject.instanceRequiredEnv[0]);
			expect(secret).toMatchObject({ kind: 'secret', required: true });
		});
	});
}
