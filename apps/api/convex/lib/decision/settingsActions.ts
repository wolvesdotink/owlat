'use node';

/**
 * The DECISION plane's half of the AI-provider settings actions.
 *
 * A sibling of `aiProviderConfigActions.ts` rather than more of it. Not for size
 * — that file has room — but because this half has a shape of its own: it is the
 * only settings surface that asks a provider a real question instead of
 * inspecting a credential, so it reaches the resolver, the gate, the breaker and
 * the ledger, none of which the other two planes' settings code touches. Keeping
 * it here is also what stops the v8 config file from importing the plane.
 *
 * Both functions here answer for the configuration that WOULD run. The test
 * resolves the plane through `lib/decisionProvider.ts` and asks through
 * `runDecision`, so the gate, the resolver's stored-then-env precedence, the
 * breaker and the ledger are the same ones an inbound decision would meet. A
 * settings surface that reimplemented any of them would, sooner or later,
 * answer for a configuration that never runs — which is the failure mode of
 * every "test connection" button that builds its own client.
 *
 * Neither function persists anything, and neither returns a key.
 */

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { decryptSecret } from '../credentialCrypto';
import {
	DEFAULT_DECISION_KIND,
	decisionProviderFor,
	type DecisionAllowance,
	type DecisionProviderKind,
} from '../decisionProviders';
import {
	decisionClientConfigFor,
	resolveDecisionConfig,
	resolveDecisionProvider,
} from '../decisionProvider';
import type { ProviderClientConfig } from '../llmProviders/types';
import { fetchGuarded } from '../ssrfGuard';
import { validateOutboundUrl } from '../outboundUrlValidation';
import { runDecision } from './dispatch';
import { decisionBreakerPort, decisionUsageRecorder } from './ports';
import {
	CONNECTION_PROBE_FEATURE,
	CONNECTION_PROBE_QUESTIONS,
	CONNECTION_PROBE_STATE,
} from './catalog';

/**
 * The decision plane's stored key, or `undefined` when any of its four envelope
 * columns is absent. The five decision columns are written and cleared in
 * lockstep by `aiProviderConfig._persistConfig`; the fifth — the masked preview —
 * is for the UI and plays no part in decryption.
 */
function storedDecisionKey(row: Doc<'aiProviderConfig'>): string | undefined {
	if (
		row.decisionSecretCiphertext === undefined ||
		row.decisionSecretIv === undefined ||
		row.decisionSecretAuthTag === undefined ||
		row.decisionSecretEnvelopeVersion === undefined
	) {
		return undefined;
	}
	return decryptSecret({
		ciphertext: row.decisionSecretCiphertext,
		iv: row.decisionSecretIv,
		authTag: row.decisionSecretAuthTag,
		version: row.decisionSecretEnvelopeVersion,
	});
}

/**
 * The client config the stored DECISION plane would run under. Decryption is
 * this module's job; the PRECEDENCE is the resolver's, so this only decrypts and
 * hands both stored values over — a test button that reimplemented "stored key,
 * then the deployment's" would eventually answer for a config that never runs.
 */
function decisionClientConfig(
	row: Doc<'aiProviderConfig'>,
	kind: DecisionProviderKind
): ProviderClientConfig {
	return decisionClientConfigFor(kind, storedDecisionKey(row), row.decisionBaseUrl);
}

/**
 * Test the stored DECISION provider — for real, against the vendor.
 *
 * A local credential check answers the wrong question. A key that is
 * well-formed and revoked passes it, and then fails every decision afterwards
 * on the inbound path, where nobody is watching a button. So this asks the plane
 * the smallest question there is ({@link CONNECTION_PROBE_QUESTIONS}: one Noul
 * over a nine-word state, a handful of input tokens, output free) through the
 * same `runDecision` a call site would use, and reports the adapter's own words
 * for a 401, a 404, a refused redirect or a timeout.
 *
 * Through the SAME path, deliberately: the resolver decides which adapter and
 * which credential answer, the gate decides whether the plane may be reached at
 * all, and the breaker hears about the outcome. A test button that reimplemented
 * any of the three would eventually answer for a configuration that never runs.
 *
 * Four things it refuses to do. It never hops to the language plane — a test
 * that passes because the FALLBACK worked is a test that lies. It never retries
 * (`maxAttempts: 1`), because an operator pressing a button wants an answer, not
 * a backoff curve. It returns the plane's degraded reason rather than probing,
 * when the stored config cannot produce a client. And it persists nothing and
 * returns no key.
 */
export async function testDecisionPlane(ctx: ActionCtx): Promise<{ ok: boolean; error?: string }> {
	// Resolved, not read off the row: this is the config that would answer a real
	// decision, including a key the deployment supplies through its environment.
	const plane = await resolveDecisionConfig(ctx);
	if (plane.degradedFrom !== undefined) {
		return { ok: false, error: plane.degradedReason ?? 'The decision provider is not configured.' };
	}
	if (plane.kind === DEFAULT_DECISION_KIND) {
		return { ok: false, error: 'No decision provider is configured yet.' };
	}

	let allowance: DecisionAllowance;
	try {
		allowance = await ctx.runMutation(internal.decision.gate.assertDecisionAllowed, {});
	} catch (e) {
		// The kill switch is off, or the instance-global bucket is empty. Both are
		// true answers to "can this deployment reach the plane right now", and
		// neither should send anything to the vendor to find out.
		return { ok: false, error: e instanceof Error ? e.message : 'The decision plane is disabled.' };
	}

	try {
		const decided = await runDecision({
			feature: CONNECTION_PROBE_FEATURE,
			state: CONNECTION_PROBE_STATE,
			questions: CONNECTION_PROBE_QUESTIONS,
			provider: await resolveDecisionProvider(ctx),
			allowance,
			maxAttempts: 1,
			breaker: decisionBreakerPort(ctx),
			recordUsage: decisionUsageRecorder(ctx),
		});
		// An answer that came back uncalibrated means the provider served a model
		// the thresholds were not measured against — the key works and the plane
		// would answer, but every threshold downstream is inert, so the button
		// must not report a plain success.
		return decided.calibrated
			? { ok: true }
			: {
					ok: false,
					error:
						`The key works, but ${decisionProviderFor(plane.kind).label} answered with '${decided.modelUsed}' rather than the ` +
						'pinned model version. Answers from it are treated as uncalibrated and thresholds ' +
						'stay inert until the calibration harness has been re-run.',
				};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'Connection test failed.' };
	}
}

/**
 * The model ids the stored DECISION provider exposes. The native adapter serves
 * a documented catalog rather than a discovery call, so this usually makes no
 * request at all; the guarded https fetcher is supplied anyway, because the day
 * an adapter does reach out, the key rides that request. Fails soft, like its
 * language sibling: a listing error is returned inline, never thrown.
 */
export async function listDecisionModels(
	ctx: ActionCtx,
	row: Doc<'aiProviderConfig'>
): Promise<{ supported: boolean; models: string[]; error?: string }> {
	const kind = row.decisionProviderKind;
	if (kind === undefined) return { supported: false, models: [] };
	const adapter = decisionProviderFor(kind);
	// Bound to a local so the narrowing survives the await below.
	const discover = adapter.listModels;
	if (!discover) return { supported: false, models: [] };
	try {
		const cfg = decisionClientConfig(row, kind);
		const baseUrl = cfg.baseUrl ?? adapter.defaultBaseUrl;
		if (baseUrl !== undefined) {
			const check = validateOutboundUrl(baseUrl, { requirePublic: true });
			if (!check.ok) {
				return { supported: true, models: [], error: `Base URL ${check.error}.` };
			}
		}
		const models = await discover({
			...cfg,
			fetchImpl: async (input, init) => {
				await ctx.runMutation(internal.decision.gate.assertDecisionAllowed, {});
				return fetchGuarded(input, { ...init, protocols: ['https:'] });
			},
		});
		return { supported: true, models };
	} catch (e) {
		return {
			supported: true,
			models: [],
			error: e instanceof Error ? e.message : 'Could not load models.',
		};
	}
}
