/**
 * THE SEND-PROVIDER CONFORMANCE BODY — what the host requires of a bundled
 * transport, written once and run against every subject that claims to be one.
 *
 * Two suites in this package drive it: `pluginProviderParity.test.ts` over the
 * hand-written Mock ESP (P3.3 — "can a package be a provider?") and
 * `scaffoldedProviderConformance.test.ts` over `owlat plugins create --template
 * send-provider`'s real output (P3.4 — "is the package we HAND an author already
 * one?"). Both questions are answered against the SAME rules, because they are
 * the host's rules and not either fixture's; a second copy of them would be a
 * second place to edit when `resolveRoute` grows an argument or
 * `DeliverabilityRouteError` is replaced, and a copy that is only edited in one
 * place silently stops measuring what it claims to. P5.3's real Postmark bundle
 * would have made it three.
 *
 * WHAT BELONGS HERE AND WHAT DOES NOT. A case belongs here when it asserts
 * something the HOST decides — routability under every declared strategy, the
 * fallback arm's per-domain proof gate, arm attribution, the return-path fold,
 * governed dispatch's instance resolution and its two fail-closed refusals, the
 * feedback route's registration and re-validation, the derived domain status, the
 * credential vocabulary. A case stays in its own suite when it asserts something
 * the SUBJECT decides: a module's own status→retry mapping, its wire shapes'
 * exact values, the generator's byte-for-byte output, or a binding to a copy of
 * the fixture that lives in another package.
 *
 * EVERY SUBJECT-SPECIFIC VALUE IS READ OFF THE COMPOSED ARTIFACT, never spelled:
 * the kind, the variable names, the signature contract, the credential fields.
 * A subject that renames any of them is still measured against what it now
 * declares.
 *
 * FOUR MODULES, ONE ENTRY POINT. The rules are split along the seam a reader
 * already has — where a message goes (`./sendProviderConformanceSendPath`), how
 * it is handed to the module (`./sendProviderConformanceDispatch`) and what comes
 * back (`./sendProviderConformanceFeedback`), over the subject contract in
 * `./sendProviderConformanceSubject` — because one file carrying all of them had
 * passed the repository's ~500 LOC guideline, and `examples/` is the one tree
 * `scripts/check-file-size.sh` does not walk. This file stays the only thing a
 * suite calls.
 */

import { describeGovernedDispatchConformance } from './sendProviderConformanceDispatch';
import { describeFeedbackConformance } from './sendProviderConformanceFeedback';
import { describeSendPathConformance } from './sendProviderConformanceSendPath';
import type { SendProviderConformanceSubject } from './sendProviderConformanceSubject';

export type {
	ConformanceDomainScenario,
	ConformanceObservedSend,
	ConformanceSendHarness,
	ConformanceSignatureContract,
	SendProviderConformanceSubject,
} from './sendProviderConformanceSubject';

/**
 * Every host-decided property of a bundled send transport, asserted against one
 * subject. Call it from a suite that has already mocked the generated catalogs
 * with that subject's composition.
 */
export function describeSendProviderConformance(subject: SendProviderConformanceSubject): void {
	describeSendPathConformance(subject);
	describeGovernedDispatchConformance(subject);
	describeFeedbackConformance(subject);
}
