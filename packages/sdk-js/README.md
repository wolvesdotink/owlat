# @owlat/sdk-js

Official JavaScript/TypeScript SDK for the Owlat email marketing API.

## Installation

```bash
npm install @owlat/sdk-js
# or
bun add @owlat/sdk-js
# or
pnpm add @owlat/sdk-js
```

## Quick Start

```typescript
import { Owlat } from '@owlat/sdk-js';

const owlat = new Owlat('lm_live_xxxxxxxx');

// Create a contact
const contact = await owlat.contacts.create({
  email: 'user@example.com',
  firstName: 'John',
  lastName: 'Doe',
});

// Send a transactional email
await owlat.transactional.send({
  slug: 'welcome-email',
  email: 'user@example.com',
  dataVariables: {
    userName: 'John',
    activationLink: 'https://example.com/activate/abc123',
  },
});
```

## Configuration

```typescript
// Simple initialization with API key
const owlat = new Owlat('lm_live_xxxxxxxx');

// Full configuration
const owlat = new Owlat({
  apiKey: 'lm_live_xxxxxxxx',
  // Self-hosting? Set this to your Convex deployment site URL — the API is
  // served from `https://<your-deployment>.convex.site/api/v1/*`.
  baseUrl: 'https://your-deployment.convex.site',
  timeout: 30000, // Optional, request timeout in ms (default: 30000)
});
```

> **Self-hosting:** `baseUrl` defaults to `https://api.owlat.app`. If you run Owlat yourself, set `baseUrl` to your Convex deployment site URL (`https://<your-deployment>.convex.site`).

## API Reference

### Contacts

Manage contacts in your audience.

#### Create a Contact

```typescript
const contact = await owlat.contacts.create({
  email: 'user@example.com',
  firstName: 'John',
  lastName: 'Doe',
});
```

#### Get a Contact

```typescript
// By ID
const contact = await owlat.contacts.get('contact_abc123');

// By email
const contact = await owlat.contacts.get('user@example.com');
```

#### Update a Contact

```typescript
const contact = await owlat.contacts.update('user@example.com', {
  firstName: 'Jane',
});
```

#### Delete a Contact

```typescript
await owlat.contacts.delete('user@example.com');
```

#### List Contacts

```typescript
// Pagination is cursor-based: pass `limit` and an optional `search`, then
// follow `result.pagination.cursor` to page through results.
const result = await owlat.contacts.list({
  limit: 25,
  search: 'john',
});

console.log(result.data); // Array of contacts
console.log(result.pagination.totalItems);

// Fetch the next page
if (!result.pagination.isDone) {
  const next = await owlat.contacts.list({ cursor: result.pagination.cursor });
}

// …or iterate every contact automatically (follows cursors for you):
for await (const contact of owlat.contacts.listAll({ search: 'john' })) {
  console.log(contact.email);
}
```

### Transactional Emails

Send transactional emails triggered by your application.

```typescript
const result = await owlat.transactional.send({
  // Required: recipient email
  email: 'user@example.com',

  // Required: identify the template (use slug or transactionalId)
  slug: 'welcome-email',
  // or: transactionalId: 'abc123',

  // Optional: template variables
  dataVariables: {
    userName: 'John',
    orderNumber: '12345',
  },

  // Optional: select translation (falls back to contact's language, then template default)
  language: 'de',
});

console.log(result.status); // 'queued'
console.log(result.contactCreated); // true if a new contact was created
```

### Events

Send events to trigger automations.

```typescript
const result = await owlat.events.send({
  email: 'user@example.com',
  eventName: 'purchase_completed',
  eventProperties: {
    orderId: 'order_123',
    amount: 99.99,
    productName: 'Premium Plan',
  },
  // Create contact if they don't exist
  createContactIfNotExists: true,
});

console.log(`Triggered ${result.triggeredAutomations} automations`);
```

### Topics

Manage topic memberships.

#### Add Contact to Topic

```typescript
// By email
const result = await owlat.topics.addContact({
  topicId: 'topic_abc123',
  email: 'user@example.com',
});

// By contact ID
const result = await owlat.topics.addContact({
  topicId: 'topic_abc123',
  contactId: 'contact_xyz789',
});

// Check if confirmation is pending
if (result.doiStatus === 'pending') {
  console.log('Confirmation email sent to subscriber');
}
```

#### Remove Contact from Topic

```typescript
const result = await owlat.topics.removeContact({
  topicId: 'topic_abc123',
  emailOrId: 'user@example.com', // or contact ID
});

if (result.removed) {
  console.log('Contact removed from topic');
}
```

## Error Handling

The SDK throws typed errors that you can catch and handle appropriately:

```typescript
import {
  Owlat,
  OwlatError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  InvalidStateError,
  LimitReachedError,
} from '@owlat/sdk-js';

try {
  await owlat.contacts.create({ email: 'invalid-email' });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Validation failed:', error.message);
    console.error('Error code:', error.code);
  } else if (error instanceof InvalidStateError) {
    // 422 — e.g. unverified sending domain, blocked recipient, unpublished template.
    // This is the dominant transactional failure mode.
    console.error('Cannot send yet:', error.message);
  } else if (error instanceof ForbiddenError) {
    // 403 — suspended / abuse-blocked account.
    console.error('Not permitted:', error.message);
  } else if (error instanceof ConflictError) {
    console.error('Contact already exists');
  } else if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else if (error instanceof LimitReachedError) {
    console.error('Plan limit reached:', error.message);
  } else if (error instanceof RateLimitError) {
    console.error(`Rate limited. Retry after ${error.retryAfter} seconds`);
  } else if (error instanceof NotFoundError) {
    console.error('Resource not found');
  } else if (error instanceof OwlatError) {
    console.error('API error:', error.message);
    console.error('Status code:', error.statusCode);
  }
}
```

### Error classes

| Error class | HTTP status | When |
|---|---|---|
| `AuthenticationError` | 401 | Invalid or missing API key |
| `LimitReachedError` | 402 | Plan or quota limit reached |
| `ForbiddenError` | 403 | Authenticated but not permitted (suspended / abuse-blocked) |
| `NotFoundError` | 404 | Resource does not exist |
| `ConflictError` | 409 | Duplicate resource (e.g. existing email) |
| `InvalidStateError` | 422 | Resource state blocks the operation (unverified domain, blocked recipient, unpublished template) |
| `RateLimitError` | 429 | Too many requests (transient per-second throttle) |
| `ValidationError` | 400 | Request body fails validation |

### Error Properties

All errors extend `OwlatError` and include:

- `message` - Human-readable error message
- `code` - Error code from the API (e.g., 'invalid_email', 'not_found')
- `statusCode` - HTTP status code
- `rateLimit` - Rate limit info (if available)

`RateLimitError` also includes:

- `retryAfter` - Seconds to wait before retrying

## Rate Limiting

The API enforces rate limits (10 requests per second per API key). The SDK includes rate limit info in error responses:

```typescript
try {
  // Many rapid requests...
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(`Rate limit: ${error.rateLimit?.limit} req/s`);
    console.log(`Remaining: ${error.rateLimit?.remaining}`);
    console.log(`Retry after: ${error.retryAfter}s`);

    // Wait and retry
    await sleep(error.retryAfter * 1000);
  }
}
```

## TypeScript Support

This SDK is written in TypeScript and includes full type definitions:

```typescript
import type {
  Contact,
  CreateContactParams,
  SendTransactionalParams,
  SendEventParams,
  PaginatedResponse,
} from '@owlat/sdk-js';
```

## Requirements

- Node.js 18 or later (uses native `fetch`)
- ES2022+ compatible runtime

## License

MIT
