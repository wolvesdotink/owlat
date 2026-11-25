package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.domain.DomainCheckRequest;
import com.owlat.sdk.model.domain.SendingDomainSetup;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;

public class DomainsResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/domains";

    public DomainsResource(HttpClient httpClient) {
        super(httpClient);
    }

    /**
     * Every sending domain with its verification state and each DNS record it
     * needs: the full name, the value to publish and what the last check found.
     * Needs the {@code status:read} scope.
     *
     * @throws com.owlat.sdk.exception.ForbiddenException if the key lacks
     *         the {@code status:read} scope
     */
    public List<SendingDomainSetup> list() {
        return httpClient.get(BASE_PATH, new TypeReference<ApiResponse<List<SendingDomainSetup>>>() {}).getData();
    }

    /**
     * Ask for a fresh DNS check of one sending domain, for example right after
     * publishing its records. The check runs in the background: poll
     * {@link #list()} until the domain's {@code lastCheckedAt} is at or after
     * the returned {@code requestedAt}. One check per domain per minute. Needs
     * the {@code domains:verify} scope.
     *
     * @param domain the domain name, or its {@code id} from {@link #list()}
     * @throws com.owlat.sdk.exception.NotFoundException if no sending domain
     *         has that name or id
     * @throws com.owlat.sdk.exception.RateLimitException if the domain was
     *         checked less than a minute ago
     */
    public DomainCheckRequest verify(String domain) {
        String path = BASE_PATH + "/" + URLEncoder.encode(domain, StandardCharsets.UTF_8) + "/verify";
        return httpClient.post(path, null, new TypeReference<ApiResponse<DomainCheckRequest>>() {}).getData();
    }
}
