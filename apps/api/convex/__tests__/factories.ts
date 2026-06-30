import { faker } from '@faker-js/faker';
import { FEATURE_FLAGS, type FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { GenericActionCtx, GenericMutationCtx } from 'convex/server';
import type { DataModel, Id, TableNames } from '../_generated/dataModel';

/**
 * Enable a set of feature flags in a fresh convex-test instance, including
 * the transitive closure of their `requires` dependencies (e.g. enabling
 * `ai.autonomy` also enables `ai`, `ai.agent`, and `inbox`).
 *
 * Inserts an `instanceSettings` row with the resulting flag map.
 *
 *   await enableFeatures(t, ['webhooks']);
 *   await enableFeatures(t, ['ai.autonomy']); // pulls in ai + ai.agent + inbox
 */
type TestCtx = GenericMutationCtx<DataModel> &
	Pick<GenericActionCtx<DataModel>, 'storage'>;
type TestRunner = { run: <T>(fn: (ctx: TestCtx) => Promise<T>) => Promise<T> };

export async function enableFeatures(
	// `t` is `ReturnType<typeof convexTest>` but importing that type pulls in
	// the schema and creates a cycle, so accept a generic runner shape.
	t: TestRunner,
	flags: FeatureFlagKey[]
): Promise<void> {
	const enabled = new Set<FeatureFlagKey>();
	const queue: FeatureFlagKey[] = [...flags];
	while (queue.length > 0) {
		const flag = queue.shift()!;
		if (enabled.has(flag)) continue;
		enabled.add(flag);
		const def = FEATURE_FLAGS[flag];
		for (const dep of def.requires ?? []) {
			if (!enabled.has(dep)) queue.push(dep);
		}
	}
	const featureFlags: Record<string, boolean> = {};
	for (const f of enabled) featureFlags[f] = true;
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags,
			createdAt: now,
			updatedAt: now,
		});
	});
}

/**
 * Create a typed fake ID for test data without using `as any`.
 */
function testId<T extends TableNames>(table: T): Id<T> {
  return `test_${table}_${Math.random().toString(36).slice(2)}` as unknown as Id<T>;
}

/**
 * Test data factories for Convex backend tests
 *
 * Each factory returns data ready for ctx.db.insert()
 * Use overrides parameter to customize specific fields
 */

export function createTestContact(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const email = faker.internet.email({ firstName, lastName }).toLowerCase();

  return {
    email,
    firstName,
    lastName,
    source: 'api' as const,
    timezone: faker.location.timeZone(),
    language: 'en',
    searchableText: `${email} ${firstName} ${lastName}`,
    // Per ADR-0009 doiStatus is non-optional on the contacts table.
    doiStatus: 'not_required' as const,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestCampaign(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    `${faker.word.adjective()} ${faker.word.noun()} Campaign`,
    `${faker.date.month()} Newsletter`,
    `Product Launch: ${faker.commerce.productName()}`,
    `Announcement: ${faker.company.buzzPhrase()}`,
  ]);

  return {
    name,
    status: 'draft' as const,
    fromName: faker.person.fullName(),
    fromEmail: faker.internet.email(),
    replyTo: faker.internet.email(),
    subject: faker.lorem.sentence(),
    // No `audience` by default — campaigns start unconfigured (matches the
    // real `create` mutation). Tests that need one pass
    // `audience: { kind: 'topic', topicId }` (ADR-0033).
    statsSent: 0,
    statsDelivered: 0,
    statsOpened: 0,
    statsClicked: 0,
    statsBounced: 0,
    statsUnsubscribed: 0,
    isABTest: false,
    searchableText: name.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestEmailTemplate(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    `${faker.word.adjective()} Template`,
    `${faker.date.month()} Newsletter Template`,
    `Welcome Series ${faker.number.int({ min: 1, max: 5 })}`,
  ]);

  return {
    name,
    subject: faker.lorem.sentence(),
    previewText: faker.lorem.sentence(),
    content: JSON.stringify({
      blocks: [
        {
          type: 'paragraph',
          content: faker.lorem.paragraphs(2),
        },
      ],
    }),
    htmlContent: `<p>${faker.lorem.paragraph()}</p>`,
    type: 'marketing' as const,
    status: 'draft' as const,
    showUnsubscribe: true,
    searchableText: name.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestTopic(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Newsletter Subscribers',
    'Product Updates',
    'VIP Customers',
    `${faker.word.adjective()} List`,
  ]);

  return {
    name,
    description: faker.lorem.sentence(),
    requireDoubleOptIn: faker.datatype.boolean(),
    createdAt: now,
    ...overrides,
  };
}

export function createTestApiKey(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const prefix = `owlat_${faker.string.alphanumeric(8)}`;

  return {
    name: faker.helpers.arrayElement([
      'Production API Key',
      'Development Key',
      'Integration Test Key',
      `${faker.word.adjective()} Service Key`,
    ]),
    keyHash: faker.string.alphanumeric(64),
    keyPrefix: prefix,
    scopes: ['contacts:read', 'contacts:write', 'campaigns:read'],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestEmailSend(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();

  return {
    campaignId: testId('campaigns'),
    contactId: testId('contacts'),
    contactEmail: faker.internet.email({ firstName, lastName }).toLowerCase(),
    contactFirstName: firstName,
    contactLastName: lastName,
    status: 'queued' as const,
    providerMessageId: faker.string.uuid(),
    personalizedSubject: faker.lorem.sentence(),
    queuedAt: now,
    openCount: 0,
    ...overrides,
  };
}

export function createTestAutomation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Welcome Series',
    'Onboarding Flow',
    'Re-engagement Campaign',
    `${faker.word.adjective()} Automation`,
  ]);

  return {
    name,
    description: faker.lorem.sentence(),
    triggerType: 'contact_created' as const,
    triggerConfig: undefined,
    status: 'draft' as const,
    statsEntered: 0,
    statsActive: 0,
    statsCompleted: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestAutomationStep(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const stepType = overrides['stepType'] || 'delay';

  // Canonical condition-step shape per ADR-0004:
  //   { condition: { kind, ... }, yesBranchStepIndex, noBranchStepIndex }
  // Typed as `unknown` here so the literal-narrowed validator union accepts
  // the fixture without per-call casts.
  let config: unknown = {
    duration: faker.number.int({ min: 1, max: 7 }),
    unit: faker.helpers.arrayElement(['hours', 'days'] as const),
  };
  if (stepType === 'delay') {
    config = {
      duration: faker.number.int({ min: 1, max: 7 }),
      unit: faker.helpers.arrayElement(['hours', 'days'] as const),
    };
  } else if (stepType === 'email') {
    config = {
      emailTemplateId: 'placeholder',
      subjectOverride: faker.lorem.sentence(),
    };
  } else if (stepType === 'condition') {
    config = {
      condition: {
        kind: 'contact_property' as const,
        field: 'email',
        operator: 'contains' as const,
        value: '@example.com',
      },
      yesBranchStepIndex: null,
      noBranchStepIndex: null,
    };
  }

  return {
    automationId: testId('automations'),
    stepIndex: 0,
    stepType: stepType as 'email' | 'delay' | 'condition',
    config: config as never,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestDomain(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const domain = faker.internet.domainName();
  const token1 = faker.string.alphanumeric(32);
  const token2 = faker.string.alphanumeric(32);
  const token3 = faker.string.alphanumeric(32);

  return {
    domain,
    status: 'pending' as const,
    dnsRecords: {
      spf: {
        type: 'TXT' as const,
        host: '@',
        value: 'v=spf1 include:amazonses.com ~all',
      },
      dkim: [
        { type: 'CNAME' as const, host: `${token1}._domainkey`, value: `${token1}.dkim.amazonses.com` },
        { type: 'CNAME' as const, host: `${token2}._domainkey`, value: `${token2}.dkim.amazonses.com` },
        { type: 'CNAME' as const, host: `${token3}._domainkey`, value: `${token3}.dkim.amazonses.com` },
      ],
      dmarc: {
        type: 'TXT' as const,
        host: '_dmarc',
        // No `rua=` by default — the reporting mailbox is operator-configured
        // via MTA_DMARC_RUA (see domains/dmarc.ts).
        value: `v=DMARC1; p=none`,
      },
      mailFrom: [
        { type: 'MX' as const, host: 'mail', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
        { type: 'TXT' as const, host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
      ],
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestInstanceSettings(overrides: Record<string, unknown> = {}) {
  const now = Date.now();

  return {
    timezone: faker.location.timeZone(),
    defaultFromName: faker.person.fullName(),
    defaultFromEmail: faker.internet.email(),
    emailTheme: {
      primaryColor: '#c4785a',
      fontFamily: 'Geist',
      backgroundColor: '#ffffff',
    },
    contactCount: faker.number.int({ min: 0, max: 10000 }),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestTransactionalEmail(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Welcome Email',
    'Password Reset',
    'Order Confirmation',
    'Receipt',
    'Account Verification',
  ]);
  const slug = name.toLowerCase().replace(/\s+/g, '-');

  return {
    name,
    slug,
    subject: faker.lorem.sentence(),
    content: JSON.stringify({
      blocks: [
        {
          type: 'paragraph',
          content: 'Hello {{firstName}},',
        },
        {
          type: 'paragraph',
          content: faker.lorem.paragraphs(2),
        },
      ],
    }),
    htmlContent: `<p>Hello {{firstName}},</p><p>${faker.lorem.paragraph()}</p>`,
    dataVariablesSchema: {
      firstName: 'string' as const,
      email: 'string' as const,
    },
    status: 'draft' as const,
    showUnsubscribe: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestBlockedEmail(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const email = faker.internet.email().toLowerCase();

  return {
    email,
    reason: 'bounced' as const,
    notes: faker.lorem.sentence(),
    createdAt: now,
    ...overrides,
  };
}

export function createTestSegment(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Active Users',
    'High Value Customers',
    'Recent Signups',
    `${faker.word.adjective()} Segment`,
  ]);

  return {
    name,
    description: faker.lorem.sentence(),
    filters: {
      conditions: [
        {
          kind: 'contact_property' as const,
          field: 'email',
          operator: 'contains' as const,
          value: '@example.com',
        },
      ],
      logic: 'AND' as const,
    },
    cachedCount: faker.number.int({ min: 0, max: 1000 }),
    cachedCountUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestContactActivity(overrides: Record<string, unknown> = {}) {
  const now = Date.now();

  return {
    contactId: testId('contacts'),
    activityType: 'email_opened' as const,
    metadata: {
      campaignId: 'placeholder',
      emailSendId: 'placeholder',
    },
    occurredAt: now,
    ...overrides,
  };
}

export function createTestFormSubmission(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const email = faker.internet.email({ firstName, lastName }).toLowerCase();

  return {
    formEndpointId: testId('formEndpoints'),
    contactId: testId('contacts'),
    data: {
      firstName,
      lastName,
      email,
    },
    status: 'success' as const,
    ipAddress: faker.internet.ip(),
    userAgent: faker.internet.userAgent(),
    submittedAt: now,
    ...overrides,
  };
}

export function createTestWebhook(overrides: Record<string, unknown> = {}) {
  const now = Date.now();

  return {
    name: faker.helpers.arrayElement([
      'Slack Notification',
      'CRM Integration',
      'Analytics Webhook',
    ]),
    url: faker.internet.url(),
    events: ['contact.created', 'email.sent'] as ('email.sent' | 'email.delivered' | 'email.opened' | 'email.clicked' | 'email.bounced' | 'email.complained' | 'contact.created' | 'topic.unsubscribed')[],
    isActive: true,
    secret: faker.string.alphanumeric(32),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestCustomEvent(overrides: Record<string, unknown> = {}) {
  const now = Date.now();

  return {
    contactId: testId('contacts'),
    eventName: faker.helpers.arrayElement([
      'product_viewed',
      'item_added_to_cart',
      'purchase_completed',
      'trial_started',
    ]),
    eventData: JSON.stringify({
      productId: faker.string.uuid(),
      price: faker.commerce.price(),
      currency: 'USD',
    }),
    timestamp: now,
    ...overrides,
  };
}

// ============================================================
// Vision Implementation Factories
// ============================================================

export function createTestInboundMessage(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    messageId: `<${faker.string.uuid()}@example.com>`,
    from: `${faker.person.firstName()} <${faker.internet.email().toLowerCase()}>`,
    to: faker.internet.email().toLowerCase(),
    subject: faker.lorem.sentence(),
    textBody: faker.lorem.paragraphs(2),
    htmlBody: `<p>${faker.lorem.paragraph()}</p>`,
    processingStatus: 'received' as const,
    receivedAt: now,
    threadId: testId('conversationThreads'),
    contactId: testId('contacts'),
    ...overrides,
  };
}

export function createTestConversationThread(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const subject = faker.lorem.sentence();
  return {
    subject,
    normalizedSubject: subject.toLowerCase(),
    contactId: testId('contacts'),
    contactIdentifier: faker.internet.email().toLowerCase(),
    channel: 'email' as const,
    status: 'open' as const,
    messageCount: 1,
    lastMessageAt: now,
    firstMessageAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestAgentAction(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    inboundMessageId: testId('inboundMessages'),
    actionType: 'security_scan' as const,
    status: 'running' as const,
    retryCount: 0,
    createdAt: now,
    ...overrides,
  };
}

export function createTestAgentConfig(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  // Note: master on/off is the `ai.agent` feature flag, not a column.
  // Use enableFeatures(t, ['ai.agent']) in tests that need the agent enabled.
  return {
    isAutoReplyEnabled: false,
    confidenceThreshold: 0.85,
    toneDescription: 'Professional and friendly',
    signatureTemplate: 'Best regards,\nThe Team',
    maxDailyAutoReplies: 50,
    autoReplyCount: 0,
    autoReplyCountResetAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestKnowledgeEntry(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const title = faker.lorem.sentence();
  const content = faker.lorem.sentence();
  return {
    entryType: 'fact' as const,
    title,
    content,
    sourceType: 'agent_extracted' as const,
    confidence: 0.8,
    embedding: Array.from({ length: 1536 }, () => Math.random()),
    searchableText: `${title} ${content}`,
    lastValidatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestKnowledgeRelation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    fromEntryId: testId('knowledgeEntries'),
    toEntryId: testId('knowledgeEntries'),
    relationType: 'supports' as const,
    // Manual-edge defaults: a fully-trusted, directly-authored edge.
    confidenceTag: 'extracted' as const,
    confidence: 1.0,
    provenance: 'manual' as const,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestContactIdentity(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    contactId: testId('contacts'),
    channel: 'email',
    identifier: faker.internet.email().toLowerCase(),
    isPrimary: true,
    createdAt: now,
    ...overrides,
  };
}

export function createTestContactRelationship(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    fromContactId: testId('contacts'),
    toContactId: testId('contacts'),
    relationship: 'colleague',
    confidence: 0.9,
    source: 'manual' as const,
    createdAt: now,
    ...overrides,
  };
}

export function createTestUnifiedMessage(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    threadId: testId('conversationThreads'),
    channel: 'email' as const,
    direction: 'inbound' as const,
    content: JSON.stringify({ text: faker.lorem.sentence() }),
    status: 'received' as const,
    createdAt: now,
    ...overrides,
  };
}

export function createTestChannelConfig(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    channel: 'email' as const,
    isEnabled: true,
    displayName: 'Email',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestAutonomyRule(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    category: 'support',
    autoApproveThreshold: 0.85,
    maxDailyAutoActions: 50,
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestAgentMetric(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    metricType: 'queue_depth' as const,
    value: 5,
    windowStart: now - 300000,
    windowEnd: now,
    createdAt: now,
    ...overrides,
  };
}

export function createTestCodeWorkTask(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    description: faker.lorem.sentence(),
    status: 'queued' as const,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestSemanticFile(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    storageId: testId('_storage' as 'inboundMessages') as unknown as Id<'_storage'>,
    filename: faker.system.fileName(),
    mimeType: 'application/pdf',
    fileSize: faker.number.int({ min: 1000, max: 10000000 }),
    sourceType: 'upload' as const,
    version: 1,
    embedding: [] as number[],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTestDashboardLayout(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    userId: 'test-user',
    rules: [],
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Helper function to create realistic campaign stats
 */
export function createRealisticCampaignStats(sent = 1000) {
  const delivered = Math.floor(sent * faker.number.float({ min: 0.95, max: 0.99 }));
  const opened = Math.floor(delivered * faker.number.float({ min: 0.15, max: 0.35 }));
  const clicked = Math.floor(opened * faker.number.float({ min: 0.1, max: 0.3 }));
  const bounced = sent - delivered;
  const unsubscribed = Math.floor(delivered * faker.number.float({ min: 0.001, max: 0.01 }));

  return {
    statsSent: sent,
    statsDelivered: delivered,
    statsOpened: opened,
    statsClicked: clicked,
    statsBounced: bounced,
    statsUnsubscribed: unsubscribed,
  };
}

/**
 * Helper function to create a complete email send with realistic status progression
 */
export function createTestEmailSendWithHistory(
  status: 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' = 'delivered',
  overrides: Record<string, unknown> = {}
) {
  const now = Date.now();
  const queuedAt = now - 3600000; // 1 hour ago
  const sentAt = queuedAt + 60000; // 1 minute later
  const deliveredAt = sentAt + 120000; // 2 minutes after sent
  const openedAt = deliveredAt + 300000; // 5 minutes after delivered
  const clickedAt = openedAt + 60000; // 1 minute after opened

  const baseData = createTestEmailSend({
    queuedAt,
    sentAt: status !== 'queued' ? sentAt : undefined,
    deliveredAt: ['delivered', 'opened', 'clicked'].includes(status) ? deliveredAt : undefined,
    openedAt: ['opened', 'clicked'].includes(status) ? openedAt : undefined,
    clickedAt: status === 'clicked' ? clickedAt : undefined,
    status,
    openCount: ['opened', 'clicked'].includes(status) ? faker.number.int({ min: 1, max: 5 }) : 0,
    clickedLinks: status === 'clicked' ? [
      {
        url: faker.internet.url(),
        clickedAt,
      },
    ] : undefined,
    ...overrides,
  });

  return baseData;
}
