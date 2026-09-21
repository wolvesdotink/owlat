/**
 * Shared test fixtures. The key pair is fixed so signature expectations are
 * reproducible byte-for-byte across machines and runs.
 */
import type {
	AppealBody,
	AttestationKind,
	AuditFindingBody,
	KeyObservationBody,
	PostureBody,
	ResponseBody,
	RetractionBody,
	SpamReportBatchBody,
	TrafficSummaryBody,
	TrapHitBody,
	UnsignedAttestation,
	VouchBody,
	VouchRevokeBody,
} from '../../types.js';
import { validateAttestation } from '../validate.js';

export const FIXED_PRIVATE_KEY = 'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDvvQ/nT040=';
export const FIXED_PUBLIC_KEY = '7LA40H1E04PS9o11qI3oTmc6dzB0cVVW9n8PgUpa7/c=';

export const GOLDEN_UNSIGNED: UnsignedAttestation<TrafficSummaryBody> = {
	v: 1,
	kind: 'traffic-summary',
	observer: 'mx.hinterland.camp',
	subject: { domain: 'example.com' },
	window: { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' },
	body: {
		messages: 1200,
		spfPass: 1180,
		dkimPass: 1195,
		dmarcPass: 1175,
		tlsInbound: 1200,
		uniqueRecipientsBucket: 2,
		bounceRateBucket: 1,
	},
};

/** Hand-written RFC 8785 form of {@link GOLDEN_UNSIGNED} — audit it by eye. */
export const GOLDEN_CANONICAL =
	'{"body":{"bounceRateBucket":1,"dkimPass":1195,"dmarcPass":1175,"messages":1200,' +
	'"spfPass":1180,"tlsInbound":1200,"uniqueRecipientsBucket":2},"kind":"traffic-summary",' +
	'"observer":"mx.hinterland.camp","subject":{"domain":"example.com"},"v":1,' +
	'"window":{"from":"2026-08-19T00:00:00Z","to":"2026-08-20T00:00:00Z"}}';

/** ed25519 over {@link GOLDEN_CANONICAL} with {@link FIXED_PRIVATE_KEY}. */
export const GOLDEN_SIGNATURE =
	'ed25519:EBxz4uQu6KR/+bZoSP7r8JAI1A0kd3kr7kAEEgjy4acn3+aJzdyXCa+xk2vPYLPwDfX4WZNL7cjKzGjI1e7HBA==';

/**
 * The body interface behind each kind. Declared here rather than in `types.ts`
 * because it exists to TYPE THE FIXTURES: a kind whose body moves must break
 * the accepted rows below, not silently keep 400-odd tests green.
 */
interface BodyByKind {
	'traffic-summary': TrafficSummaryBody;
	'spam-report-batch': SpamReportBatchBody;
	'trap-hit': TrapHitBody;
	'key-observation': KeyObservationBody;
	posture: PostureBody;
	vouch: VouchBody;
	'vouch-revoke': VouchRevokeBody;
	appeal: AppealBody;
	response: ResponseBody;
	retraction: RetractionBody;
	'audit-finding': AuditFindingBody;
}

/** A valid body for every kind, used as the accepted row of the tables. */
export const VALID_BODIES: { [K in AttestationKind]: BodyByKind[K] } = {
	'traffic-summary': { ...GOLDEN_UNSIGNED.body },
	'spam-report-batch': { reports: 7, commitment: 'a'.repeat(64) },
	'trap-hit': { hits: 3 },
	'key-observation': {
		domain: 'example.com',
		selector: 'mail2026',
		publicKey: `sha256:${'b'.repeat(64)}`,
		firstSeen: '2026-08-01T00:00:00Z',
		lastSeen: '2026-08-19T12:00:00Z',
		dnssecValidated: true,
	},
	posture: {
		dmarcPolicy: 'reject',
		dmarcAlignment: 'strict',
		dnssec: true,
		mtaSts: true,
		tlsRpt: false,
		declaredIps: ['192.0.2.7', '2001:db8::1'],
		registeredBefore: '2019-01-01T00:00:00Z',
	},
	vouch: { scope: 'transactional mail only', expires: '2027-01-01T00:00:00Z' },
	'vouch-revoke': {
		vouch: { logId: 'log.ostr.example', index: 41 },
		reason: 'scope no longer accurate',
	},
	appeal: {
		contested: [{ logId: 'log.ostr.example', index: 12 }],
		statement: 'we never sent this mail',
	},
	response: {
		appeal: { logId: 'log.ostr.example', index: 99 },
		outcome: 'substantiated',
		statement: 'sampled bundles verified',
	},
	retraction: {
		supersedes: { logId: 'log.ostr.example', index: 5 },
		reason: 'counted a test run',
	},
	'audit-finding': {
		finding: 'equivocation',
		evidence: [{ logId: 'log.ostr.example', index: 1 }],
		statement: 'two signed tree heads for one size',
	},
};

/** Kinds whose body is a claim about a period (plan §5). */
export const WINDOWED_KINDS: AttestationKind[] = [
	'traffic-summary',
	'spam-report-batch',
	'trap-hit',
];

/**
 * Errors for `kind` with its accepted body patched by `patch`; an `undefined`
 * value deletes the field, which is how the required-field rows are written.
 */
export function bodyErrors(kind: AttestationKind, patch: Record<string, unknown>): string[] {
	const body: Record<string, unknown> = { ...VALID_BODIES[kind], ...patch };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete body[key];
	}
	const result = validateAttestation(attestationOf(kind, { body }));
	return result.ok ? [] : result.errors;
}

/** A structurally valid, plausibly-signed attestation of any kind. */
export function attestationOf(
	kind: AttestationKind,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		v: 1,
		kind,
		observer: 'mx.hinterland.camp',
		subject: { domain: 'example.com' },
		body: VALID_BODIES[kind],
		sig: GOLDEN_SIGNATURE,
	};
	if (WINDOWED_KINDS.includes(kind)) {
		base['window'] = { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' };
	}
	return { ...base, ...overrides };
}
