package com.owlat.sdk.model.contact;

public class CreateContactParams {

    private final String email;
    private final String firstName;
    private final String lastName;

    private CreateContactParams(Builder builder) {
        this.email = builder.email;
        this.firstName = builder.firstName;
        this.lastName = builder.lastName;
    }

    public String getEmail() {
        return email;
    }

    public String getFirstName() {
        return firstName;
    }

    public String getLastName() {
        return lastName;
    }

    public static Builder builder(String email) {
        return new Builder(email);
    }

    public static class Builder {
        private final String email;
        private String firstName;
        private String lastName;

        private Builder(String email) {
            this.email = email;
        }

        public Builder firstName(String firstName) {
            this.firstName = firstName;
            return this;
        }

        public Builder lastName(String lastName) {
            this.lastName = lastName;
            return this;
        }

        public CreateContactParams build() {
            return new CreateContactParams(this);
        }
    }
}
