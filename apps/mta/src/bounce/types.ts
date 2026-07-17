/**
 * Shared types for the Bounce attempt — the per-inbound-message execution
 * path that runs through the **Bounce intake pipeline** and **Bounce
 * outcome** modules.
 *
 * Mirrors `apps/mta/src/dispatch/types.ts` (ADR-0007). The two MTA-side
 * Inbound-event producers (Dispatch attempt outcome + Bounce intake) share
 * the same module shape: typed phases that classify, a pure reducer that
 * emits a typed effect list, and a runner that's the only seam to
 * Redis / metrics / Convex.
 */

import type Redis from 'ioredis';
import type { ParsedMessage } from '@owlat/mail-message';
import type { MtaConfig } from '../config.js';
import type { InboundRoute } from '../inbound/router.js';
import type { MailboxCacheEntry } from '../inbound/mailboxResolver.js';
import type { BounceClassification } from '../types.js';

/**
 * The base ctx every Phase receives — derived purely from what the SMTP
 * onData handler has already buffered and parsed.
 */
export interface BasePhaseCtx {
	readonly parsed: ParsedMessage;
	readonly rawBuffer: Buffer;
	readonly rcptTo: string | undefined;
	/**
	 * Inbound DKIM verdict (RFC 6376 / RFC 8601) computed by `onData` over
	 * the raw bytes before the pipeline runs. Threaded onto the personal-
	 * mailbox `inbound.mailbox.received` payload as `dkimResult`. Undefined
	 * only on the dispatch-side ctx that never runs DKIM (kept optional so
	 * the dispatch reducer's `BasePhaseCtx` consumers don't break).
	 */
	readonly dkimResult?: string;
	/**
	 * Inbound DMARC verdict (RFC 7489 / RFC 8601) computed by `onData` after
	 * SPF + DKIM are known: the From-domain policy is fetched and SPF/DKIM
	 * alignment is checked. Threaded onto the personal-mailbox payload as
	 * `dmarcResult` so Convex stores it and routes a quarantine/reject fail to
	 * Spam. `undefined` on the dispatch-side ctx that never runs DMARC.
	 */
	readonly dmarcResult?: string;
	/**
	 * The published DMARC policy (`none`/`quarantine`/`reject`) that applied to
	 * the From domain, captured alongside `dmarcResult`. The Convex side routes a
	 * quarantine/reject fail to Spam; a `p=none` fail is recorded but not moved.
	 */
	readonly dmarcPolicy?: string;
	/**
	 * SPF evaluation result for the SMTP envelope sender (MAIL FROM), as
	 * computed in `onMailFrom` and threaded through the session. RFC 7208 §2.6
	 * verdict string (`pass` | `fail` | `softfail` | `neutral` | `none` |
	 * `temperror` | `permerror`). `undefined` when SPF checking is disabled or
	 * the return path is empty (DSN). The reducer surfaces this onto the
	 * mailbox payload so Convex can store it and route on it (RFC 8601).
	 */
	readonly spfResult?: SpfVerdict;
	/**
	 * DMARC alignment input: the SMTP envelope MAIL FROM domain (the SPF-
	 * authenticated identity), captured in `onMailFrom` and threaded through the
	 * session. Surfaced onto the inbound payloads beside the verdicts so the
	 * Convex reader can later compare it against the visible From domain.
	 * `undefined` when SPF is disabled or MAIL FROM is empty (DSN).
	 */
	readonly envelopeFromDomain?: string;
	/**
	 * DMARC alignment input: the `d=` domain of the passing DKIM signature
	 * (`dkim.domain`), captured in `onData`. Surfaced onto the inbound payloads
	 * beside the verdicts. `undefined` when DKIM is disabled or no signature
	 * verified.
	 */
	readonly dkimSigningDomain?: string;
	/**
	 * Inbound ARC chain-validation result (`cv=`, RFC 8617) computed by `onData`
	 * over the raw bytes (Sealed Mail A5). Threaded onto the mailbox payload so
	 * the Convex delivery path can rescue a DMARC fail when a TRUSTED forwarder
	 * sealed a valid chain attesting the original passed. `undefined` when ARC is
	 * disabled, no chain is present, or on the dispatch-side ctx.
	 */
	readonly arcCv?: string;
	/** `d=` of the outermost ARC seal — the forwarder vouching for the message. */
	readonly arcSealerDomain?: string;
	/** Whether the sealer's AAR attests the original passed authentication. */
	readonly arcAttestsOriginalPass?: boolean;
	/**
	 * The SMTP envelope sender (MAIL FROM / return-path), as taken from
	 * `session.envelope.mailFrom` in `onData`. Normalized so the RFC 5321
	 * §4.5.5 null sender (`<>`) and a missing MAIL FROM both surface as the
	 * empty string `''`; a real return path is the bare address.
	 *
	 * Threaded onto the mailbox payload as `returnPath` so the Convex
	 * post-delivery hook can suppress vacation auto-replies to bounces /
	 * delivery-status notifications (RFC 3834 §2) keyed off the *envelope*
	 * rather than the spoofable `From:` header.
	 */
	readonly returnPath?: string;
}

/** RFC 7208 §2.6 / RFC 8601 SPF result keyword. */
export type SpfVerdict =
	| 'pass'
	| 'fail'
	| 'softfail'
	| 'neutral'
	| 'none'
	| 'temperror'
	| 'permerror';

/**
 * The ctx after `resolveRoute` enriches it for the inbound-accept branch.
 *
 * Only this branch needs `stageAttachments` to run; every other terminal
 * classification (FBL, DSN, mailbox, endpoint, hold, route_bounce,
 * unrecognized) short-circuits the pipeline before this phase. `rcptTo` is
 * narrowed to `string` here because `resolveRoute` short-circuits for
 * undefined recipients.
 */
export interface CtxWithAcceptRoute extends Omit<BasePhaseCtx, 'rcptTo'> {
	readonly rcptTo: string;
	readonly route: InboundRoute;
}

/**
 * Dependencies the pipeline runner and effect runner consume.
 *
 * Phases never import the Redis client or the MtaConfig directly — they read
 * what they need off this struct so tests can substitute a stub.
 */
export interface PhaseDeps {
	readonly redis: Redis;
	readonly config: MtaConfig;
}

/**
 * Attachment metadata staged for the `inbound.received` Convex payload.
 *
 * The `redisKey` is generated deterministically by the reducer so the
 * staging effect and the notify payload can both reference it; the runner
 * is what actually `SETEX`-es the bytes.
 */
export interface InboundAttachmentMeta {
	readonly filename: string | undefined;
	readonly contentType: string;
	readonly size: number;
	readonly redisKey: string | undefined;
}

/**
 * Per-attachment payload the reducer consumes when emitting `stage_attachment`
 * effects + the notify_convex event for inbound-accept.
 */
export interface InboundAttachmentInput {
	readonly index: number;
	readonly filename: string | undefined;
	readonly contentType: string;
	readonly size: number;
	readonly contentBase64: string | undefined;
}

/**
 * Per-attachment payload for the personal-mailbox `inbound.mailbox.received`
 * Convex payload. Mailbox attachments are not Redis-staged today —
 * Convex stores the full raw RFC822, so attachments can be re-extracted
 * downstream.
 */
export interface MailboxAttachmentMeta {
	readonly filename: string;
	readonly contentType: string;
	readonly size: number;
	readonly contentId: string | undefined;
	readonly partIndex: string;
}

/**
 * The seven terminal classifications the Bounce intake pipeline produces.
 *
 * `dropSilently` is the eighth terminal outcome (returned by `parseFblOrDsn`
 * on duplicate ARF complaints); it never reaches the reducer because no
 * effects are required.
 */
export type BounceAttempt =
	| {
			readonly kind: 'fbl';
			readonly arf: BounceClassification;
	  }
	| {
			readonly kind: 'dsn_attributed';
			readonly bounce: BounceClassification;
	  }
	| {
			readonly kind: 'dsn_unattributed';
	  }
	| {
			readonly kind: 'mailbox';
			readonly mailbox: MailboxCacheEntry;
			readonly rcptTo: string;
			readonly attachments: ReadonlyArray<MailboxAttachmentMeta>;
			readonly toAddrs: ReadonlyArray<string>;
			readonly ccAddrs: ReadonlyArray<string>;
			readonly bccAddrs: ReadonlyArray<string>;
			readonly references: string | undefined;
			/** Inbound DKIM verdict (RFC 8601), passed through to the payload. */
			readonly dkimResult: string | undefined;
			/** Inbound DMARC verdict (RFC 8601), passed through to the payload. */
			readonly dmarcResult: string | undefined;
			/** Published DMARC policy (`none`/`quarantine`/`reject`), for routing. */
			readonly dmarcPolicy: string | undefined;
			/** Inbound ARC chain-validation result (`cv=`, RFC 8617) — Sealed Mail A5. */
			readonly arcCv: string | undefined;
			/** `d=` of the outermost ARC seal — the forwarder vouching. */
			readonly arcSealerDomain: string | undefined;
			/** Whether the sealer's AAR attests the original passed. */
			readonly arcAttestsOriginalPass: boolean | undefined;
	  }
	| {
			readonly kind: 'endpoint_forward';
			readonly route: InboundRoute;
			readonly rcptTo: string;
	  }
	| {
			readonly kind: 'inbound_accept';
			readonly route: InboundRoute;
			readonly rcptTo: string;
			readonly attachments: ReadonlyArray<InboundAttachmentInput>;
			readonly headers: Readonly<Record<string, string>>;
	  }
	| {
			readonly kind: 'route_hold';
			readonly route: InboundRoute;
			readonly rcptTo: string;
	  }
	| {
			readonly kind: 'route_bounce';
			readonly route: InboundRoute;
			readonly rcptTo: string;
	  }
	| {
			readonly kind: 'unrecognized';
			readonly rcptTo: string | undefined;
	  };
