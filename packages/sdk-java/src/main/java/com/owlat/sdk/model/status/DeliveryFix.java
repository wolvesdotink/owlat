package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Where the fix for a delivery problem is made, and who can make it. */
public class DeliveryFix {

    private final String route;
    private final String who;

    @JsonCreator
    public DeliveryFix(@JsonProperty("route") String route, @JsonProperty("who") String who) {
        this.route = route;
        this.who = who;
    }

    /** Path of the page in the instance's web app, for example {@code /dashboard/admin/delivery/domains}. */
    public String getRoute() {
        return route;
    }

    /** {@code workspace_admin}, {@code platform_admin}, {@code contact_manager} or {@code deployment_operator}. */
    public String getWho() {
        return who;
    }
}
