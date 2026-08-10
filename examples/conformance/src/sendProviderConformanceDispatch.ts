/**
 * GOVERNED DISPATCH — the rules the HOST enforces around one send, driven through
 * `sendProviderDispatch` rather than around it. Part of the send-provider
 * conformance body; see `./sendProviderConformance`.
 *
 * These were written twice, once per subject, until the only real difference
 * turned out to be how each subject's "network" is arranged and read back — which
 * is what `subject.send` is. Everything else (which instance's credential must
 * reach the module, which grant is rechecked and when, and the two refusals that
 * must happen before third-party code runs) is the host's, and a second copy of it
 * was a second place to edit when `sendProviderDispatch`'s recheck argument set
 * changed.
 *
 * WHAT GENUINELY STAYS WITH A SUBJECT: the status→retry-budget mapping its own
 * module implements (P3.4's suite) and the `buildDispatchExtrasFor` seam (P3.3's),
 * because those are assertions about the MODULE rather than about the host.
 *
 * Its own module rather than a fifth block in `./sendProviderConformanceSendPath`,
 * because that file had reached the repository's ~500 LOC guideline — the one
 * `scripts/check-file-size.sh` enforces everywhere it walks, which is not
 * `examples/`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendProviderDispatch } from '@owlat/api/sendProviders/dispatch';
import { EmailErrorCode } from '@owlat/api/sendProviders/types';
import type { SendProviderConformanceSubject } from './sendProviderConformanceSubject';

/**
 * The values a deployment would set, distinguishable from each other so a case can
 * tell WHICH instance's configuration reached the module. Spelled here rather than
 * by each subject: which value ends up on the wire is the host's decision.
 */
const DEFAULT_CREDENTIAL = 'conformance-default-credential';
const INSTANCE_CREDENTIAL = 'conformance-eu-credential';
const DEFAULT_OPTIONAL = 'conformance-default-optional';
const INSTANCE_OPTIONAL = 'conformance-eu-optional';

export function describeGovernedDispatchConformance(subject: SendProviderConformanceSubject): void {
	const KIND = subject.kind;

	describe('a send goes out through the module the bundle ships', () => {
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

		/** Everything a real deployment would set for this bundle, both instances. */
		function stubConfiguredEnv(): void {
			for (const name of subject.flagRequiredEnv) vi.stubEnv(name, 'true');
			vi.stubEnv(subject.signature.secretEnvVar, subject.webhookSecretValue);
			for (const name of subject.instanceRequiredEnv) {
				vi.stubEnv(name, DEFAULT_CREDENTIAL);
				vi.stubEnv(`${name}__EU`, INSTANCE_CREDENTIAL);
			}
			for (const name of subject.instanceOptionalEnv) {
				vi.stubEnv(name, DEFAULT_OPTIONAL);
				vi.stubEnv(`${name}__EU`, INSTANCE_OPTIONAL);
			}
		}

		afterEach(() => {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		});

		/**
		 * NAMED INSTANCES, which is the parity gap D4 opened and P3.1 closed — and
		 * the property a bundle is most likely to break, because the wrong shape (a
		 * `process.env` read) also "works" on the default instance.
		 *
		 * The send is addressed to `#eu`, so the module must be handed the
		 * `__EU`-suffixed values keyed by their BASE names — a module that never
		 * heard of instances still reads the right ones. Handing it the deployment
		 * default here would be the silent credential borrow instance resolution
		 * exists to prevent, and the assertion reads the values back off the request
		 * the module MADE rather than off the configuration it was given.
		 */
		it("sends on the addressed instance's own credentials, and nothing else", async () => {
			vi.stubEnv('SEND_TRANSPORT_INSTANCES', `${KIND}#eu`);
			stubConfiguredEnv();
			subject.send.arrange();

			const context = fakeContext();
			const result = await sendProviderDispatch(context as never, `${KIND}#eu` as never, message);

			// THE GRANT IS RECHECKED BEFORE THE MODULE RUNS, on the BARE kind: an
			// instance suffix must not smuggle a send past the plugin's authorization.
			expect(context.runMutation).toHaveBeenCalledTimes(1);
			expect(context.runMutation).toHaveBeenCalledWith(expect.anything(), {
				pluginId: subject.pluginId,
				providerKind: KIND,
				priorAttempts: 0,
			});
			expect(result).toMatchObject({
				providerType: KIND,
				transportId: `${KIND}#eu`,
				attempts: 1,
				result: { success: true },
			});
			// The instance's values, both of them — the optional variable is
			// instance-scoped too, and a resolver that suffixed only the required one
			// would send this message with another instance's region.
			expect(subject.send.attempts()).toEqual([
				{ credential: INSTANCE_CREDENTIAL, optional: INSTANCE_OPTIONAL },
			]);
		});

		// The default instance is the same path with no suffix, and it proves the
		// suffix above was doing something rather than being the only value present.
		it('sends on the deployment-default instance for the bare kind', async () => {
			stubConfiguredEnv();
			subject.send.arrange();

			await sendProviderDispatch(fakeContext() as never, KIND, message);

			expect(subject.send.attempts()).toEqual([
				{ credential: DEFAULT_CREDENTIAL, optional: DEFAULT_OPTIONAL },
			]);
		});

		/*
		 * THE TWO FAIL-CLOSED CASES BELOW HAVE SHIPPED HOMES, and are not copies of
		 * them. `pluginCapabilityParity.test.ts` ("fails the attempt CLOSED when a
		 * required variable is missing, without calling the module") and
		 * `pluginDispatch.integration.test.ts` ("does not invoke plugin code when the
		 * last-moment authorization is denied") own the rules — but both drive
		 * `createHostedSendProvider` over a HAND-BUILT `SendTransportRecord`. What
		 * these add is the half those bypass: the COMPOSED catalog resolving the
		 * kind, the `SEND_TRANSPORT_INSTANCES` registry resolving the transport id,
		 * and `sendProviderDispatch` in front of both.
		 *
		 * The ERROR CODE is asserted for the same reason in both: `success: false`
		 * with no attempt recorded is also what a THROW looks like — `runAttempt`
		 * catches everything and answers `UNKNOWN` — so a bare `success: false`
		 * assertion would stay green while the operator-facing failure stopped being
		 * attributable to credentials or to the grant.
		 */

		it('never calls the module when a required credential is unset', async () => {
			for (const name of subject.flagRequiredEnv) vi.stubEnv(name, 'true');
			vi.stubEnv(subject.signature.secretEnvVar, subject.webhookSecretValue);
			subject.send.arrange();

			const result = await sendProviderDispatch(fakeContext() as never, KIND, message);

			expect(result.result).toMatchObject({
				success: false,
				errorCode: EmailErrorCode.AUTH_FAILED,
			});
			expect(subject.send.attempts()).toEqual([]);
		});

		// AND THE REVOKED GRANT, which is the other reason the module must not run.
		// The operator has taken `send:transport` away between the route resolving
		// and the attempt being made; the recheck notices BEFORE the send rather than
		// after a message has left.
		it('never calls the module when the capability grant is refused', async () => {
			stubConfiguredEnv();
			subject.send.arrange();

			const context = fakeContext(false);
			const result = await sendProviderDispatch(context as never, KIND, message);

			expect(context.runMutation).toHaveBeenCalledTimes(1);
			expect(result.result).toMatchObject({
				success: false,
				errorCode: EmailErrorCode.AUTH_FAILED,
			});
			expect(subject.send.attempts()).toEqual([]);
		});
	});
}
