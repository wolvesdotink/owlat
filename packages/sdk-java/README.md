# Owlat Java SDK

Java SDK for the [Owlat](https://owlat.app) email marketing API. Requires Java 11+.

## Installation

### Maven

```xml
<dependency>
    <groupId>com.owlat</groupId>
    <artifactId>owlat-sdk</artifactId>
    <version>0.1.0</version>
</dependency>
```

### Gradle

```groovy
implementation 'com.owlat:owlat-sdk:0.1.0'
```

## Quick Start

```java
import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.model.contact.Contact;
import com.owlat.sdk.model.contact.CreateContactParams;

Owlat owlat = new Owlat(
    OwlatConfig.builder("lm_live_xxxxxxxx")
        .baseUrl("https://rest.api.example.com")
        .build()
);

// Create a contact
Contact contact = owlat.contacts().create(
    CreateContactParams.builder("user@example.com")
        .firstName("John")
        .lastName("Doe")
        .build()
);
```

`baseUrl` is your instance's API URL: the web app shows it as **Your API base URL** under **Settings → API → API quickstart**. It is the `NUXT_PUBLIC_CONVEX_SITE_URL` your operator set, `https://rest.api.<your-domain>` when the setup wizard derived it from your domain.

> **No `baseUrl`:** the client sends requests and your API key to `https://api.owlat.app`, which is not your instance, and logs a warning through `java.util.logging`. `new Owlat(String apiKey)` does the same and is deprecated. The base URL will become required.

## Configuration

```java
import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.RetryConfig;
import java.time.Duration;

Owlat owlat = new Owlat(
    OwlatConfig.builder("lm_live_xxxxxxxx")
        .baseUrl("https://rest.api.example.com")
        .timeout(Duration.ofSeconds(60))
        // Optional: tune automatic retries (defaults to 2 retries,
        // 500ms initial backoff, ×2 multiplier).
        .retry(RetryConfig.builder().maxRetries(3).initialDelayMs(250).build())
        .build()
);
```

### Retries

Transient failures are retried automatically with exponential backoff. A `429`
is retried after the wait it names (see below), up to 30 seconds; a longer wait (a send
limit that refills in minutes, or the daily limit) throws a
`RateLimitException` at once, and `getRetryAfter()` says when to try again.
That wait can be hours, so hand a long one to a job queue rather than sleeping
the thread for it.

When a `429` carries both `data.retryAfter` in its error body and a
`Retry-After` header, the body wins: it comes from the instance and goes with
the `data.reason` it names, while the header may come from a proxy in front.
A body value is any positive number of seconds, rounded up; a header value
counts only as a positive whole number of seconds, so an HTTP date, a negative
or a decimal header is ignored and the SDK backs off as for a `5xx`. A wait too
large for a 32-bit integer is capped at 2147483647. `getRetryAfter()` on the exception is
the wait the SDK went by, or `1` when the response named none it could read.
The JS SDK applies the same rule.

A `5xx`, network error, or timeout
is retried for idempotent methods (`GET`/`PUT`/`DELETE`) and for a `POST` send
made with an idempotency key. The server applies a keyed send at most once per
key for 24 hours and answers a repeat with the first response; a send without a
key is never replayed, since a retry could duplicate it. Reusing a key for a
different request throws a `ConflictException` (409). A retry whose contact was deleted after the first attempt throws one too, since its response is no longer kept. Idempotency keys need an
Owlat server released after 0.6.16.

```java
owlat.transactional().send(
    SendTransactionalParams.builder("user@example.com").slug("order-confirmation").build(),
    RequestOptions.idempotencyKey("order-" + orderId + "-confirmation"));
```

Disable retries entirely with `RetryConfig.disabled()`:

```java
OwlatConfig.builder("lm_live_xxxxxxxx")
    .baseUrl("https://rest.api.example.com")
    .retry(RetryConfig.disabled())
    .build();
```

## Resources

### Contacts

```java
// Create
Contact contact = owlat.contacts().create(
    CreateContactParams.builder("user@example.com")
        .firstName("John")
        .build()
);

// Get by ID or email
Contact contact = owlat.contacts().get("user@example.com");

// Update
Contact updated = owlat.contacts().update("user@example.com",
    UpdateContactParams.builder()
        .firstName("Jane")
        .build()
);

// Delete
DeleteContactResponse response = owlat.contacts().delete("user@example.com");

// List with cursor-based pagination
PaginatedResponse<Contact> page = owlat.contacts().list(
    PaginationParams.builder()
        .limit(25)
        .search("jane")
        .build()
);

// Fetch the next page using the returned cursor
if (!page.getPagination().isDone()) {
    PaginatedResponse<Contact> next = owlat.contacts().list(
        PaginationParams.builder()
            .cursor(page.getPagination().getCursor())
            .build()
    );
}

// Or stream every contact, following cursors automatically. Pages are fetched
// lazily as the stream is consumed, so the full set is never held in memory.
owlat.contacts()
    .listAll(PaginationParams.builder().search("jane").build())
    .forEach(c -> System.out.println(c.getEmail()));
```

### Transactional Emails

```java
SendTransactionalResponse response = owlat.transactional().send(
    SendTransactionalParams.builder("user@example.com")
        .slug("welcome-email")
        .dataVariables(Map.of("name", "John"))
        .build()
);

// Later: where the send stands. Every email.* webhook for it carries the same
// id as `sendId`.
TransactionalSendStatus send = owlat.transactional().get(response.getTransactionalEmailId());
send.getStatus();    // "queued", "sent", "delivered", "failed", ...
send.getErrorCode(); // e.g. "MTA_UNREACHABLE" once it failed

// Without the id: the sends to one address (or in one state), newest first,
// within at most the last 30 days.
CursorPaginatedResponse<TransactionalSendStatus> sends = owlat.transactional().list(
    ListTransactionalSendsParams.builder().email("user@example.com").build());
```

### Events

```java
SendEventResponse response = owlat.events().send(
    SendEventParams.builder("user@example.com", "signup_completed")
        .eventProperties(Map.of("plan", "pro"))
        .createContactIfNotExists(true)
        .build()
);
```

### Topics

```java
// List topics (needs the topics:read scope); getId() is the topic ID below
PaginatedResponse<Topic> topics = owlat.topics().list();

// Add contact to topic
AddToTopicResponse response = owlat.topics().addContact(
    AddToTopicParams.builder("topic_123")
        .email("user@example.com")
        .build()
);

// Remove contact from topic
RemoveFromTopicResponse response = owlat.topics().removeContact(
    new RemoveFromTopicParams("topic_123", "user@example.com")
);
```

### Status

Whether the instance can send and, if not, why and what fixes it. Needs the
`status:read` scope.

```java
DeliveryStatus status = owlat.status().get();
status.getLevel();       // "ok", "warn" or "error"
status.getReasonCode();  // e.g. "domain_failed"
status.getFix();         // the page in the web app that fixes it, or null
status.getSendingHold(); // set while sending is suspended or banned, or null
```

### Domains

Every sending domain with its verification state and the DNS records it needs.
Needs the `status:read` scope.

```java
for (SendingDomainSetup domain : owlat.domains().list()) {
    domain.getStatus();  // "verified", "pending", ...
    domain.getRecords(); // each with getHost(), getValue() and getState(): found, wrong, missing or unchecked
}
```

After publishing records, ask for a fresh check and poll the list until it has
run. This needs the `domains:verify` scope; one check per domain per minute.

```java
DomainCheckRequest check = owlat.domains().verify("news.example.com");
String requestedAt = check.getRequestedAt();
```

### Templates

Transactional emails and saved blocks: read, write and publish. Reads need the
`templates:read` scope, writes `templates:write`. A read is the export, and
`toInput()` gives what `upsert` takes.

```java
TransactionalEmail email = owlat.transactionalEmails().get("order-confirmation");
owlat.transactionalEmails().upsert(email.getSlug(), email.toInput(),
        TransactionalEmailWriteOptions.ifRevision(email.getRevision()).whilePublished());
owlat.transactionalEmails().publish("order-confirmation");
CursorPaginatedResponse<SavedBlockSummary> savedBlocks = owlat.savedBlocks().list();
```

## Error Handling

All exceptions extend `OwlatException` (unchecked) and include the HTTP status code and rate limit info.

```java
import com.owlat.sdk.exception.*;

try {
    owlat.contacts().get("nonexistent@example.com");
} catch (NotFoundException e) {
    System.err.println("Not found: " + e.getMessage());
} catch (AuthenticationException e) {
    System.err.println("Invalid API key");
} catch (RateLimitException e) {
    System.err.println("Rate limited. Retry after " + e.getRetryAfter() + "s");
} catch (ValidationException e) {
    System.err.println("Invalid request: " + e.getMessage());
} catch (ConflictException e) {
    System.err.println("Conflict: " + e.getMessage());
} catch (UnexpectedResponseException e) {
    // The answer did not come from the Owlat API: check baseUrl.
    System.err.println("Not an Owlat API: " + e.getUrl() + " " + e.getStatusCode() + " " + e.getBodyExcerpt());
} catch (OwlatException e) {
    System.err.println("API error " + e.getStatusCode() + ": " + e.getMessage());
}
```

## Building

```bash
cd packages/sdk-java
mvn compile
mvn test
```
