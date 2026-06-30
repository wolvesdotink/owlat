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
import com.owlat.sdk.model.contact.Contact;
import com.owlat.sdk.model.contact.CreateContactParams;

Owlat owlat = new Owlat("lm_live_xxxxxxxx");

// Create a contact
Contact contact = owlat.contacts().create(
    CreateContactParams.builder("user@example.com")
        .firstName("John")
        .lastName("Doe")
        .build()
);
```

## Configuration

```java
import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.RetryConfig;
import java.time.Duration;

Owlat owlat = new Owlat(
    OwlatConfig.builder("lm_live_xxxxxxxx")
        .baseUrl("https://api.owlat.app")
        .timeout(Duration.ofSeconds(60))
        // Optional: tune automatic retries (defaults to 2 retries,
        // 500ms initial backoff, ×2 multiplier).
        .retry(RetryConfig.builder().maxRetries(3).initialDelayMs(250).build())
        .build()
);
```

### Retries

Transient failures are retried automatically with exponential backoff. A `429`
is always retried (honoring `Retry-After`); a `5xx`, network error, or timeout
is only retried for idempotent methods (`GET`/`PUT`/`DELETE`) — a non-idempotent
`POST` send is never replayed, since the server has no idempotency key and a
retry could duplicate the send. Disable retries entirely with
`RetryConfig.disabled()`:

```java
OwlatConfig.builder("lm_live_xxxxxxxx")
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
