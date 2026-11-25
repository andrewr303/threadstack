---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Paperclip instance.

## Live events over HTTP

`GET /api/companies/{companyId}/events/stream` provides a same-origin
`text/event-stream` alternative for an authenticated browser embedded in
ThreadStack. Ordinary pages retain the WebSocket transport. The endpoint uses
the existing HTTP session or board API authentication and company access guard;
it adds no cookie changes, authentication tickets, or URL credentials.

Each default SSE message has `data: <JSON>` containing the same viewer-filtered
`LiveEvent` payload as the WebSocket stream. It uses the same task, run, case,
project, skill, revocation, and transcript-redaction checks. Full company agent
API keys are accepted for their own company; restricted agent keys and run JWTs
are refused, matching the native live-event key boundary. Browser clients use
`new EventSource(path, { withCredentials: true })`.

The stream has no bidirectional run-interest negotiation. It sends the existing
default company delivery, with bounded buffering; persistent backlog closes the
connection so the client can reconnect and resync ordinary reads. A comment
establishes the connection, and a comment keepalive runs every 30 seconds only
while it is connected. Disconnect and server shutdown remove subscriptions and
clear that keepalive. Idle connections perform no database polling.

## List Companies

```
GET /api/companies
```

Requires a board user. Returns companies where the user has active membership.
Instance administrators and the local trusted board can list all companies.

For navigation and company selectors, use `GET /api/companies?scope=accessible`.
This returns only companies the caller can enter through company-scoped routes,
including for instance administrators. Instance administrator status alone does
not grant access to a company's contents. The local trusted board can still
enter all companies. The board UI uses this scope for its company list, so it
does not select companies the user cannot open.
The Instance Access screen uses the unscoped directory so administrators can
manage membership for all companies. A supplied `scope` must be a single
`accessible` value; empty, unknown, or repeated values return `400`.

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## Update Company

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

## Upload Company Logo

Upload an image for a company icon and store it as that company’s logo.

```
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

Valid image content types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

Company logo uploads use the normal Paperclip attachment size limit.

Then set the company logo by PATCHing the returned `assetId` into `logoAssetId`.

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Get Agent Trace Export Status

```
GET /api/companies/{companyId}/observability/status
```

Returns whether agent trace export is set up for the company. Every member of the company and every agent in it can read this. It never returns the destination or any credential. Reading or changing the full settings at `/api/companies/{companyId}/observability` stays with board users who can manage connections.

| Field | Type | Description |
|-------|------|-------------|
| `configured` | boolean | Whether a destination is saved |
| `enabled` | boolean | Whether export is on |
| `provider` | string \| null | Destination provider, for example `otlp` |
| `credentialsConfigured` | boolean | Whether credentials are saved for the destination |
| `updatedAt` | string \| null | When the settings last changed |
| `lastTest` | object \| null | Latest connection test: `status` and `finishedAt` |

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `logoAssetId` | string | Optional asset id for the stored logo image |
| `logoUrl` | string | Optional Paperclip asset content path for the stored logo image |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
