package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.PaginatedResponse;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.contact.Contact;
import com.owlat.sdk.model.contact.CreateContactParams;
import com.owlat.sdk.model.contact.DeleteContactResponse;
import com.owlat.sdk.model.contact.UpdateContactParams;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Spliterator;
import java.util.Spliterators;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

public class ContactsResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/contacts";

    public ContactsResource(HttpClient httpClient) {
        super(httpClient);
    }

    /**
     * URL-encode a path parameter (handles emails with + and other special chars).
     */
    private static String encodePath(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    public Contact create(CreateContactParams params) {
        return httpClient
                .post(BASE_PATH, params, new TypeReference<ApiResponse<Contact>>() {})
                .getData();
    }

    public Contact get(String idOrEmail) {
        return httpClient
                .get(BASE_PATH + "/" + encodePath(idOrEmail), new TypeReference<ApiResponse<Contact>>() {})
                .getData();
    }

    public Contact update(String idOrEmail, UpdateContactParams params) {
        return httpClient
                .put(BASE_PATH + "/" + encodePath(idOrEmail), params, new TypeReference<ApiResponse<Contact>>() {})
                .getData();
    }

    public DeleteContactResponse delete(String idOrEmail) {
        return httpClient
                .delete(BASE_PATH + "/" + encodePath(idOrEmail), new TypeReference<ApiResponse<DeleteContactResponse>>() {})
                .getData();
    }

    public PaginatedResponse<Contact> list() {
        return list(null);
    }

    /**
     * List contacts with cursor-based pagination and optional search.
     *
     * <p>Pagination is cursor-based: pass the {@code cursor} from the previous
     * response's {@link com.owlat.sdk.model.PaginationMeta#getCursor()} to fetch
     * the next page, and stop once
     * {@link com.owlat.sdk.model.PaginationMeta#isDone()} is true. There is no
     * row ceiling — every contact is reachable. Search results are
     * relevance-ordered.
     */
    public PaginatedResponse<Contact> list(PaginationParams params) {
        String path = BASE_PATH;
        if (params != null) {
            path += params.toQueryString();
        }
        return httpClient.get(path, new TypeReference<PaginatedResponse<Contact>>() {});
    }

    /**
     * Lazily stream every contact, following cursors until the server reports
     * {@link com.owlat.sdk.model.PaginationMeta#isDone()}. Mirrors the JS SDK's
     * {@code listAll} async iterator (sdk-js src/resources/contacts.ts): pages
     * are fetched on demand as the stream is consumed, so the caller never holds
     * the full set in memory and partial consumption only fetches what it reads.
     */
    public Stream<Contact> listAll() {
        return listAll(null);
    }

    /**
     * Lazily stream every contact matching {@code params}, following cursors
     * until the server reports {@link com.owlat.sdk.model.PaginationMeta#isDone()}.
     *
     * <p>Only the page size ({@code limit}) and {@code search} from
     * {@code params} are honored; any {@code cursor} is ignored — iteration
     * always starts from the beginning, matching the JS SDK's
     * {@code Omit<PaginationParams, 'cursor'>} contract. Pages are fetched on
     * demand as the stream is consumed, so the caller never holds the full set
     * in memory.
     *
     * @param params optional page size ({@code limit}) and {@code search}; may
     *               be {@code null} for defaults
     */
    public Stream<Contact> listAll(PaginationParams params) {
        Integer limit = params != null ? params.getLimit() : null;
        String search = params != null ? params.getSearch() : null;
        Iterator<Contact> iterator = new ContactPageIterator(limit, search);
        return StreamSupport.stream(
                Spliterators.spliteratorUnknownSize(iterator, Spliterator.ORDERED | Spliterator.NONNULL),
                false);
    }

    /**
     * Cursor-following iterator over all contacts. Fetches one page at a time,
     * advancing by the server's cursor until {@code isDone}. Starts from the
     * first page (no cursor), so any caller-supplied cursor is intentionally
     * ignored — matching the JS {@code listAll} semantics.
     */
    private final class ContactPageIterator implements Iterator<Contact> {
        private final Integer limit;
        private final String search;

        private Iterator<Contact> pageItems = Collections.emptyIterator();
        private String nextCursor;
        private boolean started;
        private boolean exhausted;

        private ContactPageIterator(Integer limit, String search) {
            this.limit = limit;
            this.search = search;
        }

        @Override
        public boolean hasNext() {
            while (!pageItems.hasNext() && !exhausted) {
                fetchNextPage();
            }
            return pageItems.hasNext();
        }

        @Override
        public Contact next() {
            if (!hasNext()) {
                throw new NoSuchElementException();
            }
            return pageItems.next();
        }

        private void fetchNextPage() {
            // After the first page we follow the server's cursor; once a page
            // reports isDone there is no further cursor to follow.
            if (started && nextCursor == null) {
                exhausted = true;
                return;
            }

            PaginationParams.Builder builder = PaginationParams.builder();
            if (limit != null) {
                builder.limit(limit);
            }
            if (search != null) {
                builder.search(search);
            }
            if (nextCursor != null) {
                builder.cursor(nextCursor);
            }

            PaginatedResponse<Contact> page = list(builder.build());
            started = true;

            List<Contact> items = page.getData();
            pageItems = items != null ? items.iterator() : Collections.emptyIterator();

            nextCursor = (page.getPagination() != null && !page.getPagination().isDone())
                    ? page.getPagination().getCursor()
                    : null;
        }
    }
}
