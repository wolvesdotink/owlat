import { getRequired } from '../env';
/**
 * AWS SES Identity Management Service
 *
 * Wraps SES v1 identity APIs for domain registration, verification,
 * MAIL FROM configuration, and identity deletion.
 */

import {
	SESClient,
	VerifyDomainIdentityCommand,
	VerifyDomainDkimCommand,
	SetIdentityMailFromDomainCommand,
	GetIdentityVerificationAttributesCommand,
	GetIdentityDkimAttributesCommand,
	DeleteIdentityCommand,
} from '@aws-sdk/client-ses';

/**
 * Build an `SESClient` from the AWS SES credential triple in the environment.
 * Single source of the client construction — the SES send provider's client
 * getter (`lib/sendProviders/ses/index.ts`) calls this too. Throws via
 * `getRequired` with a clear message if any of the three vars is unset.
 */
export function resolveSesClient(): SESClient {
	return new SESClient({
		region: getRequired('AWS_SES_REGION'),
		credentials: {
			accessKeyId: getRequired('AWS_SES_ACCESS_KEY_ID'),
			secretAccessKey: getRequired('AWS_SES_SECRET_ACCESS_KEY'),
		},
	});
}

export interface SESRegistrationResult {
	verificationToken: string;
	dkimTokens: string[];
}

export interface SESVerificationStatus {
	verificationStatus: string; // "Pending" | "Success" | "Failed" | "TemporaryFailure" | "NotStarted"
	dkimStatus: string; // "Pending" | "Success" | "Failed" | "TemporaryFailure" | "NotStarted"
	dkimTokens: string[];
}

export class SESIdentityManager {
	private client: SESClient;
	private region: string;

	constructor(config: { client: SESClient; region: string }) {
		this.region = config.region;
		this.client = config.client;
	}

	/**
	 * Register a domain identity with SES.
	 * Calls VerifyDomainIdentity + VerifyDomainDkim to get verification token and DKIM tokens.
	 */
	async registerDomain(domain: string): Promise<SESRegistrationResult> {
		// Verify domain identity - returns a TXT verification token
		const identityResult = await this.client.send(
			new VerifyDomainIdentityCommand({ Domain: domain })
		);

		if (!identityResult.VerificationToken) {
			throw new Error('SES did not return a verification token');
		}

		// Enable DKIM signing - returns 3 DKIM tokens
		const dkimResult = await this.client.send(
			new VerifyDomainDkimCommand({ Domain: domain })
		);

		if (!dkimResult.DkimTokens || dkimResult.DkimTokens.length === 0) {
			throw new Error('SES did not return DKIM tokens');
		}

		return {
			verificationToken: identityResult.VerificationToken,
			dkimTokens: dkimResult.DkimTokens,
		};
	}

	/**
	 * Set up a custom MAIL FROM domain for full DMARC SPF alignment.
	 * E.g., sets `mail.example.com` as the MAIL FROM subdomain.
	 */
	async setupMailFromDomain(domain: string, mailFromSubdomain: string): Promise<void> {
		await this.client.send(
			new SetIdentityMailFromDomainCommand({
				Identity: domain,
				MailFromDomain: `${mailFromSubdomain}.${domain}`,
			})
		);
	}

	/**
	 * Get the current verification status of a domain from SES.
	 */
	async getVerificationStatus(domain: string): Promise<SESVerificationStatus> {
		const [verificationResult, dkimResult] = await Promise.all([
			this.client.send(
				new GetIdentityVerificationAttributesCommand({
					Identities: [domain],
				})
			),
			this.client.send(
				new GetIdentityDkimAttributesCommand({
					Identities: [domain],
				})
			),
		]);

		const verificationAttrs =
			verificationResult.VerificationAttributes?.[domain];
		const dkimAttrs = dkimResult.DkimAttributes?.[domain];

		return {
			verificationStatus: verificationAttrs?.VerificationStatus ?? 'NotStarted',
			dkimStatus: dkimAttrs?.DkimVerificationStatus ?? 'NotStarted',
			dkimTokens: dkimAttrs?.DkimTokens ?? [],
		};
	}

	/**
	 * Delete a domain identity from SES.
	 */
	async deleteIdentity(domain: string): Promise<void> {
		await this.client.send(
			new DeleteIdentityCommand({ Identity: domain })
		);
	}

	/**
	 * Get the SES region (needed for MAIL FROM MX record value).
	 */
	getRegion(): string {
		return this.region;
	}
}

/**
 * Create an SES identity manager from environment variables.
 */
export function createSESIdentityManager(): SESIdentityManager {
	return new SESIdentityManager({
		client: resolveSesClient(),
		region: getRequired('AWS_SES_REGION'),
	});
}
