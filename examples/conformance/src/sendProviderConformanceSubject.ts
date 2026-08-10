/**
 * WHAT A SEND-PROVIDER CONFORMANCE SUBJECT HAS TO SUPPLY.
 *
 * The rules live in `./sendProviderConformanceSendPath` and
 * `./sendProviderConformanceFeedback`; this is the seam between them and the two
 * suites that run them — the Mock ESP (P3.3) and the scaffolded bundle (P3.4).
 *
 * EVERYTHING HERE IS EITHER READ OFF THE COMPOSED ARTIFACT OR A THUNK. A subject
 * never states a rule and never spells a value the composition already carries:
 * the kind, the variable names, the signature contract and the credential fields
 * are read back out of the entry the renderer produced, and the two places the
 * subjects genuinely differ — how their network is arranged and how the call they
 * received is observed — are functions the subject owns. The Mock ESP records an
 * attempt log inside its module; the scaffolded bundle's emitted module really
 * calls `fetch`, which its suite stubs. Neither difference is a rule, so neither
 * belongs in the body.
 */

import type { SendProviderKind } from '@owlat/api/sendProviders/catalog';

/** The webhook signature contract, as the composed webhook catalog carries it. */
export interface ConformanceSignatureContract {
	readonly header: string;
	readonly algorithm: string;
	readonly encoding: string;
	readonly secretEnvVar: string;
	readonly replay: { readonly timestampHeader: string; readonly toleranceSeconds: number };
}

/**
 * One arranged call into the subject's identity module.
 *
 * The subjects make their module answer in completely different ways — the Mock
 * ESP keys its answers off the domain name, the scaffolded bundle stubs `fetch` —
 * so a scenario is a THUNK: it performs whatever arrangement it needs and returns
 * the arguments to call with. That is the only part of the identity block that is
 * genuinely the subject's, and it is the only part the subject supplies.
 */
export interface ConformanceDomainScenario {
	readonly domain: string;
	readonly config: { readonly instanceKey: string | null; readonly env: Record<string, string> };
}

/**
 * One attempt the subject's send module actually made, in the two terms the host
 * decides: which instance's credential it was handed, and which instance's
 * optional value came with it.
 *
 * Both are read out of the request the module MADE rather than out of the
 * configuration it was given — that is the whole point. A module reading
 * `process.env` instead of its `config` argument is handed the right values and
 * sends with the wrong ones, and only the outgoing request can tell the two apart.
 */
export interface ConformanceObservedSend {
	/** The value the module used for the transport's first required variable. */
	readonly credential: string | undefined;
	/** The value it used for the first optional one, if it carries one at all. */
	readonly optional?: string | undefined;
}

/** How a subject's send half is arranged, and how what it did is read back. */
export interface ConformanceSendHarness {
	/**
	 * Arrange the subject's "network" so one send succeeds, and clear whatever
	 * record `attempts` reads. Called by each case before dispatch.
	 */
	readonly arrange: () => void;
	/** Every attempt the module made since `arrange`, in order. */
	readonly attempts: () => readonly ConformanceObservedSend[];
}

export interface SendProviderConformanceSubject {
	/** The composed transport kind, as the catalog serves it. */
	readonly kind: SendProviderKind;
	/** The plugin id the feedback route is keyed by. */
	readonly pluginId: string;
	/** The composed catalog entry, as a plain record. */
	readonly entry: Record<string, unknown>;
	/** The transport contribution's own configuration — what ONE instance needs. */
	readonly instanceRequiredEnv: readonly string[];
	readonly instanceOptionalEnv: readonly string[];
	/** The plugin's deployment-wide gate, read unsuffixed. */
	readonly flagRequiredEnv: readonly string[];
	/** The signature contract the composed webhook registration carries. */
	readonly signature: ConformanceSignatureContract;
	/** The value a deployment would set the signing secret to. */
	readonly webhookSecretValue: string;
	/** How to arrange and observe one send through the subject's own module. */
	readonly send: ConformanceSendHarness;
	/**
	 * One signed batch in the subject's own wire shape, and the feedback facts the
	 * host must end up with. Written by the subject because the shape is its
	 * provider's; asserted here because the CHAIN is the host's.
	 */
	readonly feedbackBatch: { readonly body: string; readonly kinds: readonly string[] };
	/** How to make the identity module answer each of the three ways that matter. */
	readonly domainScenarios: {
		readonly verified: () => ConformanceDomainScenario;
		readonly unverified: () => ConformanceDomainScenario;
		readonly authFailed: () => ConformanceDomainScenario;
	};
}
