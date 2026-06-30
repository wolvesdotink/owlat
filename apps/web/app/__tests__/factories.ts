import { faker } from '@faker-js/faker';
import type { Id, TableNames } from '@owlat/api/dataModel';

/**
 * Create a typed fake ID for test data without using `as any`.
 */
function testId<T extends TableNames>(table: T): Id<T> {
  return `test_${table}_${Math.random().toString(36).slice(2)}` as unknown as Id<T>;
}

/**
 * Test data factories for frontend component and composable tests
 *
 * These return plain objects matching the shapes returned by Convex queries
 * All objects include _id and _creationTime fields
 */

export function createMockContact(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const email = faker.internet.email({ firstName, lastName }).toLowerCase();

  return {
    _id: testId('contacts'),
    _creationTime: now - 86400000, // 1 day ago
    email,
    firstName,
    lastName,
    source: 'api' as const,
    timezone: faker.location.timeZone(),
    language: 'en',
    searchableText: `${email} ${firstName} ${lastName}`,
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockCampaign(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    `${faker.word.adjective()} ${faker.word.noun()} Campaign`,
    `${faker.date.month()} Newsletter`,
    `Product Launch: ${faker.commerce.productName()}`,
  ]);

  return {
    _id: testId('campaigns'),
    _creationTime: now - 86400000,
    name,
    status: 'draft' as const,
    fromName: faker.person.fullName(),
    fromEmail: faker.internet.email(),
    replyTo: faker.internet.email(),
    subject: faker.lorem.sentence(),
    audience: { kind: 'topic' as const, topicId: testId('topics') },
    statsSent: 0,
    statsDelivered: 0,
    statsOpened: 0,
    statsClicked: 0,
    statsBounced: 0,
    statsUnsubscribed: 0,
    isABTest: false,
    searchableText: name.toLowerCase(),
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockCampaignWithStats(overrides: Record<string, unknown> = {}) {
  const sent = faker.number.int({ min: 500, max: 5000 });
  const delivered = Math.floor(sent * faker.number.float({ min: 0.95, max: 0.99 }));
  const opened = Math.floor(delivered * faker.number.float({ min: 0.15, max: 0.35 }));
  const clicked = Math.floor(opened * faker.number.float({ min: 0.1, max: 0.3 }));

  return createMockCampaign({
    status: 'sent',
    statsSent: sent,
    statsDelivered: delivered,
    statsOpened: opened,
    statsClicked: clicked,
    statsBounced: sent - delivered,
    statsUnsubscribed: Math.floor(delivered * 0.005),
    sentAt: Date.now() - 3600000,
    ...overrides,
  });
}

export function createMockEmailTemplate(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    `${faker.word.adjective()} Template`,
    `${faker.date.month()} Newsletter Template`,
    `Welcome Series ${faker.number.int({ min: 1, max: 5 })}`,
  ]);

  return {
    _id: testId('emailTemplates'),
    _creationTime: now - 86400000,
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
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockTopic(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Newsletter Subscribers',
    'Product Updates',
    'VIP Customers',
    `${faker.word.adjective()} List`,
  ]);

  return {
    _id: testId('topics'),
    _creationTime: now - 86400000,
    name,
    description: faker.lorem.sentence(),
    requireDoubleOptIn: faker.datatype.boolean(),
    subscriberCount: faker.number.int({ min: 0, max: 1000 }),
    createdAt: now - 86400000,
    ...overrides,
  };
}

export function createMockApiKey(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const prefix = `owlat_${faker.string.alphanumeric(8)}`;

  return {
    _id: testId('apiKeys'),
    _creationTime: now - 86400000,
    name: faker.helpers.arrayElement([
      'Production API Key',
      'Development Key',
      'Integration Test Key',
    ]),
    keyHash: faker.string.alphanumeric(64),
    keyPrefix: prefix,
    scopes: ['contacts:read', 'contacts:write', 'campaigns:read'],
    isActive: true,
    lastUsedAt: now - 3600000,
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockAutomation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Welcome Series',
    'Onboarding Flow',
    'Re-engagement Campaign',
    `${faker.word.adjective()} Automation`,
  ]);

  return {
    _id: testId('automations'),
    _creationTime: now - 86400000,
    name,
    description: faker.lorem.sentence(),
    triggerType: 'contact_created' as const,
    triggerConfig: {
      conditions: [],
    },
    status: 'draft' as const,
    statsEntered: 0,
    statsActive: 0,
    statsCompleted: 0,
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockAutomationWithStats(overrides: Record<string, unknown> = {}) {
  const entered = faker.number.int({ min: 100, max: 1000 });
  const completed = Math.floor(entered * faker.number.float({ min: 0.6, max: 0.9 }));
  const active = entered - completed;

  return createMockAutomation({
    status: 'active',
    statsEntered: entered,
    statsActive: active,
    statsCompleted: completed,
    activatedAt: Date.now() - 2592000000, // 30 days ago
    ...overrides,
  });
}

export function createMockDomain(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const domain = faker.internet.domainName();

  return {
    _id: testId('domains'),
    _creationTime: now - 86400000,
    domain,
    status: 'pending' as const,
    dnsRecords: {
      spf: {
        type: 'TXT',
        name: '@',
        value: 'v=spf1 include:_spf.owlat.app ~all',
        status: 'pending',
      },
      dkim: {
        type: 'TXT',
        name: `owlat._domainkey.${domain}`,
        value: `k=rsa; p=${faker.string.alphanumeric(200)}`,
        status: 'pending',
      },
    },
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockEmailSend(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();

  return {
    _id: testId('emailSends'),
    _creationTime: now - 3600000,
    campaignId: testId('campaigns'),
    contactId: testId('contacts'),
    contactEmail: faker.internet.email({ firstName, lastName }).toLowerCase(),
    contactFirstName: firstName,
    contactLastName: lastName,
    status: 'delivered' as const,
    providerMessageId: faker.string.uuid(),
    personalizedSubject: faker.lorem.sentence(),
    queuedAt: now - 3600000,
    sentAt: now - 3540000,
    deliveredAt: now - 3480000,
    openCount: 0,
    ...overrides,
  };
}

export function createMockSegment(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Active Users',
    'High Value Customers',
    'Recent Signups',
    `${faker.word.adjective()} Segment`,
  ]);

  return {
    _id: testId('segments'),
    _creationTime: now - 86400000,
    name,
    description: faker.lorem.sentence(),
    filters: {
      conditions: [
        {
          type: 'contact_property',
          field: 'email',
          operator: 'contains',
          value: '@example.com',
        },
      ],
      logic: 'AND',
    },
    cachedCount: faker.number.int({ min: 0, max: 1000 }),
    cachedCountUpdatedAt: now - 3600000,
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockTransactionalEmail(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Welcome Email',
    'Password Reset',
    'Order Confirmation',
    'Receipt',
  ]);
  const slug = name.toLowerCase().replace(/\s+/g, '-');

  return {
    _id: testId('transactionalEmails'),
    _creationTime: now - 86400000,
    name,
    slug,
    subject: faker.lorem.sentence(),
    content: JSON.stringify({
      blocks: [
        {
          type: 'paragraph',
          content: 'Hello {{firstName}},',
        },
      ],
    }),
    status: 'draft' as const,
    showUnsubscribe: false,
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockContactActivity(overrides: Record<string, unknown> = {}) {
  const now = Date.now();

  return {
    _id: testId('contactActivities'),
    _creationTime: now - 3600000,
    contactId: testId('contacts'),
    activityType: 'email_opened' as const,
    metadata: {
      campaignId: faker.string.uuid(),
      emailSendId: faker.string.uuid(),
    },
    occurredAt: now - 3600000,
    ...overrides,
  };
}

export function createMockOrganization(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.company.name();

  return {
    _id: `test_organization_${Math.random().toString(36).slice(2)}`,
    _creationTime: now - 2592000000, // 30 days ago
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    createdAt: now - 2592000000,
    ...overrides,
  };
}

export function createMockUser(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();

  return {
    _id: `test_user_${Math.random().toString(36).slice(2)}`,
    _creationTime: now - 2592000000,
    email: faker.internet.email({ firstName, lastName }).toLowerCase(),
    name: `${firstName} ${lastName}`,
    image: faker.image.avatar(),
    emailVerified: true,
    createdAt: now - 2592000000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockForm(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const name = faker.helpers.arrayElement([
    'Contact Form',
    'Newsletter Signup',
    'Event Registration',
    'Download Form',
  ]);

  return {
    _id: testId('formEndpoints'),
    _creationTime: now - 86400000,
    name,
    description: faker.lorem.sentence(),
    fields: [
      { name: 'email', type: 'email', required: true },
      { name: 'firstName', type: 'text', required: true },
      { name: 'lastName', type: 'text', required: false },
    ],
    redirectUrl: faker.internet.url(),
    addToTopic: true,
    topicId: testId('topics'),
    submissionCount: faker.number.int({ min: 0, max: 500 }),
    isActive: true,
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockWebhook(overrides: Record<string, unknown> = {}) {
  const now = Date.now();

  return {
    _id: testId('webhooks'),
    _creationTime: now - 86400000,
    name: faker.helpers.arrayElement([
      'Slack Notification',
      'CRM Integration',
      'Analytics Webhook',
    ]),
    url: faker.internet.url(),
    events: ['contact.created', 'email.sent'],
    isActive: true,
    secret: faker.string.alphanumeric(32),
    lastTriggeredAt: now - 3600000,
    createdAt: now - 86400000,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Helper: Create multiple mock contacts at once
 */
export function createMockContacts(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, () => createMockContact(overrides));
}

/**
 * Helper: Create multiple mock campaigns at once
 */
export function createMockCampaigns(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, () => createMockCampaign(overrides));
}

/**
 * Helper: Create a realistic campaign journey (draft -> scheduled -> sent)
 */
export function createMockCampaignJourney() {
  const now = Date.now();
  const draft = createMockCampaign({ status: 'draft' });
  const scheduled = createMockCampaign({
    status: 'scheduled',
    scheduledAt: now + 86400000, // tomorrow
  });
  const sent = createMockCampaignWithStats({ status: 'sent' });

  return { draft, scheduled, sent };
}

/**
 * Helper: Create a contact with recent activity
 */
export function createMockContactWithActivity() {
  const contact = createMockContact();
  const activities = [
    createMockContactActivity({
      contactId: contact._id,
      activityType: 'contact_created',
      occurredAt: contact.createdAt,
    }),
    createMockContactActivity({
      contactId: contact._id,
      activityType: 'email_sent',
      occurredAt: contact.createdAt + 3600000,
    }),
    createMockContactActivity({
      contactId: contact._id,
      activityType: 'email_opened',
      occurredAt: contact.createdAt + 7200000,
    }),
  ];

  return { contact, activities };
}
