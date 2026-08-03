# Auth API Contract

## Session Management

### GET /api/v1/auth/sessions

Returns the authenticated user's owned sessions with pagination and metadata.

#### Business rules
- Only the authenticated user may view their own sessions.
- Sessions must be ordered by latest activity first.
- The current session must be clearly identifiable.
- Refresh and access tokens must never be exposed.

#### Query parameters
- `page` (optional, default `1`)
- `pageSize` (optional, default `20`)
- `status` (optional, default `active`)
- `sort` (optional, default `-lastActivityAt`)

#### Success response
```json
{
  "success": true,
  "data": [
    {
      "sessionId": "UUID",
      "device": "Windows Laptop",
      "browser": "Chrome",
      "ipAddress": "103.xxx.xxx.xxx",
      "createdAt": "UTC",
      "lastActivity": "UTC",
      "isCurrentSession": true,
      "status": "active"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 1
  }
}
```

### DELETE /api/v1/auth/sessions/:sessionId

Revokes one specific authenticated session.

#### Business rules
- The session must belong to the authenticated user.
- Only active sessions should be revoked.
- Revoked sessions immediately lose access.

### POST /api/v1/auth/logout-all

Revokes every active session for the authenticated user.

#### Business rules
- The current session is also revoked.
- The user must authenticate again to continue using the platform.
