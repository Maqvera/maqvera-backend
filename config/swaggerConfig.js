import swaggerJSDoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Maqvera Enterprise Platform API Documentation",
      version: "2.0.0",
      description: "Interactive OpenAPI 3.0 Documentation & Testing Suite for Maqvera ERP, AI Platform, GDS Distribution, Travel & Visa Systems",
      contact: {
        name: "Maqvera Engineering Team",
      },
    },
    servers: [
      {
        url: "http://localhost:5001/api/v1",
        description: "Local Development Server (v1 API)",
      },
      {
        url: "http://localhost:5001",
        description: "Root Server",
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your Bearer Access Token obtained from /auth/login",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "Error message details" },
            requestId: { type: "string", example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" },
          },
        },
        SuccessResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Operation completed successfully" },
            data: { type: "object" },
            requestId: { type: "string", example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" },
          },
        },
        SignupRequest: {
          type: "object",
          required: ["username", "email", "password"],
          properties: {
            username: { type: "string", example: "JohnDoe" },
            email: { type: "string", example: "john@example.com" },
            password: { type: "string", example: "Password123!" },
            tenantKey: { type: "string", example: "alnoor" },
          },
        },
        SetupTenantRequest: {
          type: "object",
          required: ["companyName", "tenantKey", "username", "email", "password"],
          properties: {
            companyName: { type: "string", example: "Atlas Travel Group" },
            tenantKey: { type: "string", example: "atlas-travel" },
            username: { type: "string", example: "SuperAdmin" },
            email: { type: "string", example: "admin@atlastravel.com" },
            password: { type: "string", example: "AdminSecurePass123!" },
          },
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", example: "john@example.com" },
            password: { type: "string", example: "Password123!" },
            tenantKey: { type: "string", example: "alnoor", description: "Optional: specify if signing in to a specific agency / tenant domain" },
            rememberMe: { type: "boolean", example: false },
          },
        },
        CreateUserRequest: {
          type: "object",
          required: ["firstName", "lastName", "email"],
          properties: {
            firstName: { type: "string", example: "Jane" },
            lastName: { type: "string", example: "Doe" },
            email: { type: "string", example: "jane@company.com" },
            role: { type: "string", example: "Administrator" },
            phone: { type: "string", example: "+1234567890" },
            designation: { type: "string", example: "Senior Travel Agent" },
            departmentId: { type: "string", example: "Operations" },
          },
        },
        InviteUserRequest: {
          type: "object",
          required: ["firstName", "lastName", "email"],
          properties: {
            firstName: { type: "string", example: "Sarah" },
            lastName: { type: "string", example: "Smith" },
            email: { type: "string", example: "sarah@company.com" },
            role: { type: "string", example: "Agent" },
            phone: { type: "string", example: "+1234567890" },
            designation: { type: "string", example: "Visa Operations Specialist" },
            departmentId: { type: "string", example: "Operations" },
          },
        },
        AcceptInvitationRequest: {
          type: "object",
          required: ["token", "username", "password"],
          properties: {
            token: { type: "string", example: "abc123tokenfromemail..." },
            username: { type: "string", example: "sarahsmith" },
            password: { type: "string", example: "SecurePass123!" },
          },
        },
        CreateCustomerRequest: {
          type: "object",
          required: ["firstName", "lastName", "email"],
          properties: {
            firstName: { type: "string", example: "Alice" },
            lastName: { type: "string", example: "Walker" },
            email: { type: "string", example: "alice.walker@example.com" },
            phone: { type: "string", example: "+1234567890" },
          },
        },
        CreateBookingRequest: {
          type: "object",
          required: ["customerId", "bookingType"],
          properties: {
            customerId: { type: "string", example: "64f1ab29c4e1234567890abc" },
            bookingType: { type: "string", example: "flight" },
            totalAmount: { type: "number", example: 550.0 },
            currency: { type: "string", example: "USD" },
          },
        },
        CreateVisaCaseRequest: {
          type: "object",
          required: ["customerId", "destinationCountry", "visaType"],
          properties: {
            customerId: { type: "string", example: "64f1ab29c4e1234567890abc" },
            destinationCountry: { type: "string", example: "GB" },
            visaType: { type: "string", example: "Tourist" },
            travelDate: { type: "string", example: "2026-10-15" },
          },
        },
        FlightSearchRequest: {
          type: "object",
          required: ["originLocationCode", "destinationLocationCode", "departureDate", "adults"],
          properties: {
            originLocationCode: { type: "string", example: "LHR" },
            destinationLocationCode: { type: "string", example: "DXB" },
            departureDate: { type: "string", example: "2026-09-01" },
            adults: { type: "integer", example: 1 },
          },
        },
        AIChatRequest: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", example: "What visa requirements apply for a UK passport traveling to Dubai?" },
          },
        },
        SendCommunicationRequest: {
          type: "object",
          required: ["channel", "recipient", "content"],
          properties: {
            channel: { type: "string", enum: ["email", "sms", "whatsapp", "push"], example: "email" },
            recipient: { type: "string", example: "customer@example.com" },
            subject: { type: "string", example: "Your Flight Booking Confirmation" },
            content: { type: "string", example: "Dear Customer, your booking #BK-1002 is confirmed." },
          },
        },
        CreateAccountRequest: {
          type: "object",
          required: ["accountCode", "accountName", "accountType", "currency"],
          properties: {
            accountCode: { type: "string", example: "1010" },
            accountName: { type: "string", example: "Operating Cash Account" },
            accountType: { type: "string", enum: ["asset", "liability", "equity", "revenue", "expense"], example: "asset" },
            currency: { type: "string", example: "USD" },
          },
        },
        CreateJournalRequest: {
          type: "object",
          required: ["journalDate", "description", "entries"],
          properties: {
            journalDate: { type: "string", example: "2026-08-17" },
            description: { type: "string", example: "Customer invoice payment settlement" },
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  accountId: { type: "string", example: "64f1ab29c4e1234567890abc" },
                  debit: { type: "number", example: 500.0 },
                  credit: { type: "number", example: 0 },
                  description: { type: "string", example: "Cash received" },
                },
              },
            },
          },
        },
      },
    },
    security: [
      {
        BearerAuth: [],
      },
    ],
    tags: [
      { name: "Authentication", description: "Signup, Login, Logout, MFA, Sessions & Security" },
      { name: "Users & Roles", description: "User Accounts, Role-Based Access Control (RBAC) & Invitations" },
      { name: "Customers", description: "Customer 360 Profiles, Passports, Documents & Emergency Contacts" },
      { name: "Bookings", description: "Booking Header, Workflow State Transitions, Travelers & Services" },
      { name: "Travel Plans", description: "Multi-Segment Itineraries & Travel Planning" },
      { name: "Visa Processing Engine", description: "Visa Cases, Requirements, Verification & Embassy Processing" },
      { name: "Flight & Hotel Distribution", description: "GDS Flight Search, Booking, Fare Rules & Hotel Distribution" },
      { name: "AI Travel Assistant", description: "Conversational AI Assistant, Supervisors & Recommendation Engine" },
      { name: "AI Knowledge Base", description: "RAG Document Indexing, Vector Search & Knowledge Ingestion" },
      { name: "AI Prompt Engineering", description: "Prompt Versioning, Rollback & Automated Test Suites" },
      { name: "AI Guardrails & Safety", description: "Content Moderation, PII Masking, Safety Policies & Audit" },
      { name: "AI Observability & Telemetry", description: "LLM Performance, Cost Tracking, Quality Metrics & SLA Alerts" },
      { name: "AI Model Router & Gateway", description: "Multi-Provider Routing, Model Fallbacks, A/B Testing & Shadow Evaluation" },
      { name: "AI Tool Orchestration", description: "Autonomous Agent Execution Plans, Validations & Human-in-the-Loop Approvals" },
      { name: "Communication Platform", description: "Multi-Channel Messaging, Email Tracking, SMS Gateway, OTP & Bulk Campaigns" },
      { name: "Finance - General Ledger & Accounts", description: "Chart of Accounts, Trial Balance, Journals, Batches & GL Recalculation" },
      { name: "Finance - Accounts Receivable & Collections", description: "AR Invoices, Payment Allocation, Installments, Debt Collection & Customer Portal" },
      { name: "Finance - Accounts Payable & Vendors", description: "Payables, Vendor Invoices, Payment Proposals & Bank Accounts" },
      { name: "Finance - Invoices, Receipts & Notes", description: "Invoicing, Credit/Debit Notes, Public Verification & Tax-Compliant Receipts" },
      { name: "Finance - Payments, Wallets & Subscriptions", description: "Payment Engine, Customer Wallets, Subscription Billing & Webhooks" },
      { name: "Finance - Banking & Reconciliation", description: "Bank Accounts, Statement Import, AI Auto-Matching & Cash Management" },
      { name: "Finance - Expenses & Vendor Payments", description: "Expense Reports, OCR Receipt Verification, Reimbursements & Vendor Payment Batches" },
      { name: "Finance - Currency, Tax & Pricing", description: "Multi-Currency Revaluation, FX Exposure, Centralized Tax Engine & Pricing Rules" },
      { name: "Finance - Approvals & Settlements", description: "Delegated Approvals, Multi-Level Workflow Rules, Gateway Settlements & Reconciliation" },
      { name: "Finance - Reporting & Dashboards", description: "GL Financial Reports, Executive/CFO/Board Dashboards & Analytics" },
      { name: "Finance - Audit, Treasury & Planning", description: "Segregation of Duties (SoD), Treasury Cash Position, EPM Budgets & Scenario Modeling" },
      { name: "Incidents & SLA", description: "Enterprise Incident Management, Severity Levels & Escalation Paths" },
      { name: "Enterprise Search", description: "Cross-Module Global Unified Search Index" },
      { name: "Reference Data", description: "Airports, Airlines, Currencies & Countries Master Catalog" },
      { name: "Notes & Audit Timeline", description: "Activity Timeline, Operational Audit Events & System Notes" },
      { name: "Integrations (Amadeus & Airlines)", description: "GDS Seat Maps, Ancillary Services, Branded Fares & Airline Sync" },
    ],
    paths: {
      // =========================================================================
      // 1. AUTHENTICATION & SECURITY
      // =========================================================================
      "/auth/signup": {
        post: {
          tags: ["Authentication"],
          summary: "Register a new employee/user account within an existing tenant",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SignupRequest" } } } },
          responses: { 201: { description: "Signup successful" }, 409: { description: "User already exists" }, 422: { description: "Invalid tenant key or password policy failure" } },
        },
      },
      "/auth/setup": {
        post: {
          tags: ["Authentication"],
          summary: "Register and provision a brand-new Company / Tenant with its initial Administrator account",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SetupTenantRequest" } } } },
          responses: { 201: { description: "Company registered successfully" }, 409: { description: "Company identifier or user already exists" }, 422: { description: "Validation / password policy failure" } },
        },
      },
      "/auth/login": {
        post: {
          tags: ["Authentication"],
          summary: "Authenticate user and issue JWT Access & Refresh tokens",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } } },
          responses: { 200: { description: "Login successful" }, 401: { description: "Invalid credentials" } },
        },
      },
      "/auth/me": {
        get: {
          tags: ["Authentication"],
          summary: "Get current authenticated user profile, permissions & tenant context",
          responses: { 200: { description: "User profile loaded" }, 401: { description: "Unauthorized" } },
        },
      },
      "/auth/refresh": {
        post: {
          tags: ["Authentication"],
          summary: "Refresh access token using a valid refresh token",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { refreshToken: { type: "string" } } } } } },
          responses: { 200: { description: "Token refreshed" }, 401: { description: "Invalid refresh token" } },
        },
      },
      "/auth/logout": {
        post: {
          tags: ["Authentication"],
          summary: "Log out user & revoke active session",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { logoutFromAllDevices: { type: "boolean", default: false } } } } } },
          responses: { 200: { description: "Logout successful" } },
        },
      },
      "/auth/forgot-password": {
        post: {
          tags: ["Authentication"],
          summary: "Request password reset email",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", example: "user@example.com" } } } } } },
          responses: { 200: { description: "Instructions sent if account exists" } },
        },
      },
      "/auth/reset-password": {
        post: {
          tags: ["Authentication"],
          summary: "Reset password using reset token",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { resetToken: { type: "string" }, newPassword: { type: "string" }, confirmPassword: { type: "string" } } } } } },
          responses: { 200: { description: "Password reset successful" } },
        },
      },
      "/auth/change-password": {
        post: {
          tags: ["Authentication"],
          summary: "Change password for authenticated user",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { currentPassword: { type: "string" }, newPassword: { type: "string" }, confirmPassword: { type: "string" } } } } } },
          responses: { 200: { description: "Password changed successfully" } },
        },
      },
      "/auth/email/send-verification": {
        post: {
          tags: ["Authentication"],
          summary: "Resend email verification link",
          responses: { 200: { description: "Verification email sent" } },
        },
      },
      "/auth/email/verify": {
        post: {
          tags: ["Authentication"],
          summary: "Verify user email using verification token",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { verificationToken: { type: "string" } } } } } },
          responses: { 200: { description: "Email verified successfully" } },
        },
      },
      "/auth/sessions": {
        get: {
          tags: ["Authentication"],
          summary: "List all active devices & sessions for the user",
          responses: { 200: { description: "Sessions listed" } },
        },
      },
      "/auth/sessions/{sessionId}": {
        delete: {
          tags: ["Authentication"],
          summary: "Revoke a specific active session",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Session revoked" } },
        },
      },
      "/auth/logout-all": {
        post: {
          tags: ["Authentication"],
          summary: "Revoke all sessions across all devices",
          responses: { 200: { description: "All sessions revoked" } },
        },
      },
      "/auth/mfa/setup": {
        post: {
          tags: ["Authentication"],
          summary: "Initiate Multi-Factor Authentication setup",
          responses: { 200: { description: "MFA setup initialized" } },
        },
      },
      "/auth/mfa/verify": {
        post: {
          tags: ["Authentication"],
          summary: "Verify MFA code and enable MFA protection",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { code: { type: "string", example: "123456" } } } } } },
          responses: { 200: { description: "MFA verified and enabled" } },
        },
      },
      "/auth/mfa/login": {
        post: {
          tags: ["Authentication"],
          summary: "Complete MFA challenge during login",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { mfaToken: { type: "string" }, code: { type: "string" } } } } } },
          responses: { 200: { description: "MFA login successful" } },
        },
      },
      "/auth/mfa/status": {
        get: {
          tags: ["Authentication"],
          summary: "Get current MFA enablement status",
          responses: { 200: { description: "MFA status returned" } },
        },
      },
      "/auth/security": {
        get: {
          tags: ["Authentication"],
          summary: "Get Security Center overview, trusted devices & metrics",
          responses: { 200: { description: "Security metrics loaded" } },
        },
      },
      "/auth/login-history": {
        get: {
          tags: ["Authentication"],
          summary: "Get login history & risk assessment audit logs",
          responses: { 200: { description: "Login history loaded" } },
        },
      },
      "/auth/preferences": {
        get: {
          tags: ["Authentication"],
          summary: "Get user interface and notification preferences",
          responses: { 200: { description: "Preferences loaded" } },
        },
        patch: {
          tags: ["Authentication"],
          summary: "Update user preferences (theme, language, timezone)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { theme: { type: "string", example: "dark" }, timezone: { type: "string", example: "UTC" } } } } } },
          responses: { 200: { description: "Preferences updated" } },
        },
      },

      // =========================================================================
      // 2. USERS & ROLES
      // =========================================================================
      "/users": {
        get: {
          tags: ["Users & Roles"],
          summary: "List all user/employee accounts within tenant",
          responses: { 200: { description: "Users list loaded" } },
        },
        post: {
          tags: ["Users & Roles"],
          summary: "Create a new employee user account",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateUserRequest" } } } },
          responses: { 201: { description: "User created" } },
        },
      },
      "/users/{userId}": {
        get: {
          tags: ["Users & Roles"],
          summary: "Get single user details by ID",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "User loaded" } },
        },
        patch: {
          tags: ["Users & Roles"],
          summary: "Update user profile details",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "User updated" } },
        },
        delete: {
          tags: ["Users & Roles"],
          summary: "Delete user account",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "User deleted" } },
        },
      },
      "/users/invite": {
        post: {
          tags: ["Users & Roles"],
          summary: "Send an email invitation link to a new team member",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InviteUserRequest" } } } },
          responses: { 201: { description: "Invitation sent successfully" }, 409: { description: "User already exists" } },
        },
      },
      "/users/accept-invitation": {
        post: {
          tags: ["Users & Roles"],
          summary: "Accept an email invitation and set user credentials (Public)",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AcceptInvitationRequest" } } } },
          responses: { 200: { description: "Invitation accepted and account activated" }, 404: { description: "Invalid or expired token" } },
        },
      },
      "/users/{userId}/status": {
        patch: {
          tags: ["Users & Roles"],
          summary: "Update user account status (active/suspended/inactive)",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["active", "suspended", "inactive"], example: "suspended" } } } } } },
          responses: { 200: { description: "Status updated" } },
        },
      },
      "/users/{userId}/role": {
        patch: {
          tags: ["Users & Roles"],
          summary: "Assign role to user",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { role: { type: "string", example: "Manager" } } } } } },
          responses: { 200: { description: "Role assigned" } },
        },
      },
      "/roles": {
        get: {
          tags: ["Users & Roles"],
          summary: "List all active RBAC roles",
          responses: { 200: { description: "Roles listed" } },
        },
        post: {
          tags: ["Users & Roles"],
          summary: "Create a new role with specific permissions",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string", example: "FinanceManager" }, permissions: { type: "array", items: { type: "string" }, example: ["finance.read", "finance.write"] } } } } } },
          responses: { 201: { description: "Role created" } },
        },
      },
      "/roles/permissions": {
        get: {
          tags: ["Users & Roles"],
          summary: "Get master catalog of available system permissions",
          responses: { 200: { description: "Permissions list returned" } },
        },
      },

      // =========================================================================
      // 3. CUSTOMERS
      // =========================================================================
      "/customers": {
        get: {
          tags: ["Customers"],
          summary: "List customer profiles",
          responses: { 200: { description: "Customer list loaded" } },
        },
        post: {
          tags: ["Customers"],
          summary: "Create a new customer profile",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateCustomerRequest" } } } },
          responses: { 201: { description: "Customer created" } },
        },
      },
      "/customers/search": {
        get: {
          tags: ["Customers"],
          summary: "Search customers by name, phone or email",
          parameters: [{ name: "q", in: "query", schema: { type: "string", example: "Alice" } }],
          responses: { 200: { description: "Search results returned" } },
        },
      },
      "/customers/{customerId}": {
        get: {
          tags: ["Customers"],
          summary: "Get customer profile by ID",
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Customer loaded" } },
        },
        patch: {
          tags: ["Customers"],
          summary: "Update customer profile",
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Customer updated" } },
        },
      },
      "/customers/{customerId}/emergency-contacts": {
        get: {
          tags: ["Customers"],
          summary: "List emergency contacts for customer",
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Emergency contacts loaded" } },
        },
        post: {
          tags: ["Customers"],
          summary: "Add an emergency contact",
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 201: { description: "Contact added" } },
        },
      },
      "/customers/{customerId}/passports": {
        get: {
          tags: ["Customers"],
          summary: "List customer passport records",
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Passports loaded" } },
        },
        post: {
          tags: ["Customers"],
          summary: "Add passport record",
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 201: { description: "Passport recorded" } },
        },
      },
      "/customers/{customerId}/timeline": {
        get: {
          tags: ["Customers"],
          summary: "Get customer interaction audit timeline",
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Timeline loaded" } },
        },
      },

      // =========================================================================
      // 4. BOOKINGS & TRAVEL PLANS
      // =========================================================================
      "/bookings": {
        get: {
          tags: ["Bookings"],
          summary: "List all booking headers",
          responses: { 200: { description: "Bookings loaded" } },
        },
        post: {
          tags: ["Bookings"],
          summary: "Create a new booking header",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateBookingRequest" } } } },
          responses: { 201: { description: "Booking created" } },
        },
      },
      "/bookings/search": {
        get: {
          tags: ["Bookings"],
          summary: "Search bookings by reference, customer or status",
          responses: { 200: { description: "Search results returned" } },
        },
      },
      "/bookings/{bookingId}": {
        get: {
          tags: ["Bookings"],
          summary: "Get booking details by ID",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Booking loaded" } },
        },
        patch: {
          tags: ["Bookings"],
          summary: "Update booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Booking updated" } },
        },
      },
      "/bookings/{bookingId}/confirm": {
        post: {
          tags: ["Bookings"],
          summary: "Confirm booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Booking confirmed" } },
        },
      },
      "/bookings/{bookingId}/cancel": {
        post: {
          tags: ["Bookings"],
          summary: "Cancel booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Booking cancelled" } },
        },
      },
      "/bookings/{bookingId}/travelers": {
        get: {
          tags: ["Bookings"],
          summary: "List travelers associated with booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Travelers listed" } },
        },
      },
      "/bookings/{bookingId}/financial-summary": {
        get: {
          tags: ["Bookings"],
          summary: "Get booking financial summary and balance",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Financial breakdown returned" } },
        },
      },
      "/travel-plans": {
        get: {
          tags: ["Travel Plans"],
          summary: "List travel itineraries",
          responses: { 200: { description: "Travel plans loaded" } },
        },
        post: {
          tags: ["Travel Plans"],
          summary: "Create a new travel plan itinerary",
          responses: { 201: { description: "Travel plan created" } },
        },
      },
      "/travel/dashboard": {
        get: {
          tags: ["Travel Plans"],
          summary: "Get travel operations dashboard KPIs",
          responses: { 200: { description: "Travel dashboard loaded" } },
        },
      },

      // =========================================================================
      // 5. VISA PROCESSING ENGINE
      // =========================================================================
      "/visa/cases": {
        get: {
          tags: ["Visa Processing Engine"],
          summary: "List visa processing cases",
          responses: { 200: { description: "Visa cases loaded" } },
        },
        post: {
          tags: ["Visa Processing Engine"],
          summary: "Create a new visa application case",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateVisaCaseRequest" } } } },
          responses: { 201: { description: "Visa case created" } },
        },
      },
      "/visa/cases/{visaCaseId}": {
        get: {
          tags: ["Visa Processing Engine"],
          summary: "Get visa case by ID",
          parameters: [{ name: "visaCaseId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Visa case details loaded" } },
        },
      },
      "/visa/cases/{visaCaseId}/transition": {
        post: {
          tags: ["Visa Processing Engine"],
          summary: "Execute workflow state machine transition for visa case",
          parameters: [{ name: "visaCaseId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { transition: { type: "string", example: "submit" } } } } } },
          responses: { 200: { description: "Workflow state transitioned" } },
        },
      },
      "/visa-types": {
        get: {
          tags: ["Visa Processing Engine"],
          summary: "Catalog of supported visa types (Public)",
          security: [],
          responses: { 200: { description: "Visa types returned" } },
        },
      },
      "/countries/{countryId}/visa-requirements": {
        get: {
          tags: ["Visa Processing Engine"],
          summary: "Get country visa requirement rules (Public)",
          security: [],
          parameters: [{ name: "countryId", in: "path", required: true, schema: { type: "string", example: "GB" } }],
          responses: { 200: { description: "Requirements loaded" } },
        },
      },
      "/dashboard": {
        get: {
          tags: ["Visa Processing Engine"],
          summary: "Get Visa Processing Dashboard Metrics & KPIs",
          responses: { 200: { description: "Dashboard data loaded" } },
        },
      },

      // =========================================================================
      // 6. FLIGHT & HOTEL DISTRIBUTION
      // =========================================================================
      "/flight-search/search": {
        post: {
          tags: ["Flight & Hotel Distribution"],
          summary: "Search flight offers via GDS provider",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/FlightSearchRequest" } } } },
          responses: { 200: { description: "Flight offers returned" } },
        },
      },
      "/flight-search/fare-rules": {
        post: {
          tags: ["Flight & Hotel Distribution"],
          summary: "Retrieve fare rules and penalties for flight offer",
          responses: { 200: { description: "Fare rules returned" } },
        },
      },
      "/flight-bookings/create": {
        post: {
          tags: ["Flight & Hotel Distribution"],
          summary: "Create flight booking and generate PNR",
          responses: { 201: { description: "Flight booking created" } },
        },
      },
      "/flight-bookings/{pnr}": {
        get: {
          tags: ["Flight & Hotel Distribution"],
          summary: "Retrieve flight booking details by PNR",
          parameters: [{ name: "pnr", in: "path", required: true, schema: { type: "string", example: "ABCD12" } }],
          responses: { 200: { description: "Booking details loaded" } },
        },
      },
      "/hotel-offers": {
        get: {
          tags: ["Flight & Hotel Distribution"],
          summary: "Search hotel distribution offers",
          responses: { 200: { description: "Hotel offers loaded" } },
        },
      },
      "/hotel-bookings": {
        post: {
          tags: ["Flight & Hotel Distribution"],
          summary: "Book hotel offer",
          responses: { 201: { description: "Hotel booking confirmed" } },
        },
      },

      // =========================================================================
      // 7. ENTERPRISE AI PLATFORM SUITE
      // =========================================================================
      "/ai/chat": {
        post: {
          tags: ["AI Travel Assistant"],
          summary: "Conversational AI Travel Assistant interface",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AIChatRequest" } } } },
          responses: { 200: { description: "AI Assistant response" } },
        },
      },
      "/ai/supervisor": {
        post: {
          tags: ["AI Travel Assistant"],
          summary: "Supervisor multi-agent conversation coordinator",
          responses: { 200: { description: "Supervisor response generated" } },
        },
      },
      "/ai/recommend": {
        post: {
          tags: ["AI Travel Assistant"],
          summary: "AI Travel Package and Service Recommendations",
          responses: { 200: { description: "Recommendations returned" } },
        },
      },
      "/ai/conversations": {
        get: {
          tags: ["AI Travel Assistant"],
          summary: "List user AI conversations",
          responses: { 200: { description: "Conversations listed" } },
        },
      },
      "/ai/knowledge/search": {
        post: {
          tags: ["AI Knowledge Base"],
          summary: "Semantic vector search across enterprise knowledge documents",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { query: { type: "string", example: "Schengen visa requirements" } } } } } },
          responses: { 200: { description: "Relevant knowledge chunks returned" } },
        },
      },
      "/ai/knowledge": {
        get: {
          tags: ["AI Knowledge Base"],
          summary: "List all indexed knowledge documents",
          responses: { 200: { description: "Documents listed" } },
        },
        post: {
          tags: ["AI Knowledge Base"],
          summary: "Upload and ingest a new knowledge document into vector store",
          responses: { 201: { description: "Knowledge document indexed" } },
        },
      },
      "/ai/prompts": {
        get: {
          tags: ["AI Prompt Engineering"],
          summary: "List all prompt templates",
          responses: { 200: { description: "Prompts listed" } },
        },
        post: {
          tags: ["AI Prompt Engineering"],
          summary: "Create a new prompt template",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { key: { type: "string" }, template: { type: "string" } } } } } },
          responses: { 201: { description: "Prompt template created" } },
        },
      },
      "/ai/prompts/{promptId}/rollback": {
        post: {
          tags: ["AI Prompt Engineering"],
          summary: "Rollback prompt to a previous stable version",
          parameters: [{ name: "promptId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Prompt version rolled back" } },
        },
      },
      "/ai/guardrails/policies": {
        get: {
          tags: ["AI Guardrails & Safety"],
          summary: "List active AI safety and content moderation policies",
          responses: { 200: { description: "Policies listed" } },
        },
        post: {
          tags: ["AI Guardrails & Safety"],
          summary: "Create a new safety guardrail policy",
          responses: { 201: { description: "Policy created" } },
        },
      },
      "/ai/guardrails/audit": {
        get: {
          tags: ["AI Guardrails & Safety"],
          summary: "Get audit logs of guardrail interventions and PII redactions",
          responses: { 200: { description: "Audit logs returned" } },
        },
      },
      "/ai/observability/dashboard/executive": {
        get: {
          tags: ["AI Observability & Telemetry"],
          summary: "Get AI platform executive overview dashboard",
          responses: { 200: { description: "Executive telemetry dashboard loaded" } },
        },
      },
      "/ai/observability/cost": {
        get: {
          tags: ["AI Observability & Telemetry"],
          summary: "Get token usage and cost metrics per provider and model",
          responses: { 200: { description: "Cost breakdown returned" } },
        },
      },
      "/ai/observability/quality": {
        get: {
          tags: ["AI Observability & Telemetry"],
          summary: "Get latency, hallucination score, and response quality metrics",
          responses: { 200: { description: "Quality metrics loaded" } },
        },
      },
      "/ai/models/catalog": {
        get: {
          tags: ["AI Model Router & Gateway"],
          summary: "List all supported LLM models and provider adapters",
          responses: { 200: { description: "Model catalog returned" } },
        },
      },
      "/ai/models/routing-policies": {
        get: {
          tags: ["AI Model Router & Gateway"],
          summary: "List dynamic model routing policies",
          responses: { 200: { description: "Routing policies listed" } },
        },
        post: {
          tags: ["AI Model Router & Gateway"],
          summary: "Create or update model routing policy",
          responses: { 200: { description: "Routing policy saved" } },
        },
      },
      "/ai/models/ab-tests": {
        get: {
          tags: ["AI Model Router & Gateway"],
          summary: "List active A/B and shadow testing experiments",
          responses: { 200: { description: "AB tests loaded" } },
        },
        post: {
          tags: ["AI Model Router & Gateway"],
          summary: "Create a new model comparison A/B test",
          responses: { 201: { description: "AB test created" } },
        },
      },
      "/ai/tools": {
        get: {
          tags: ["AI Tool Orchestration"],
          summary: "List registered autonomous agent tools",
          responses: { 200: { description: "Tools catalog listed" } },
        },
      },
      "/ai/tools/plan": {
        post: {
          tags: ["AI Tool Orchestration"],
          summary: "Generate multi-step tool execution plan for user request",
          responses: { 200: { description: "Execution plan generated" } },
        },
      },
      "/ai/tools/execute": {
        post: {
          tags: ["AI Tool Orchestration"],
          summary: "Execute approved tool orchestration plan",
          responses: { 200: { description: "Plan executed successfully" } },
        },
      },

      // =========================================================================
      // 8. MULTI-CHANNEL COMMUNICATION PLATFORM
      // =========================================================================
      "/communication/send": {
        post: {
          tags: ["Communication Platform"],
          summary: "Send multi-channel communication (Email, SMS, WhatsApp)",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SendCommunicationRequest" } } } },
          responses: { 200: { description: "Message queued for delivery" } },
        },
      },
      "/communication/messages": {
        get: {
          tags: ["Communication Platform"],
          summary: "List delivery tracking status for sent messages",
          responses: { 200: { description: "Messages listed" } },
        },
      },
      "/communication/templates": {
        get: {
          tags: ["Communication Platform"],
          summary: "List notification templates",
          responses: { 200: { description: "Templates listed" } },
        },
        post: {
          tags: ["Communication Platform"],
          summary: "Create a new email/SMS template",
          responses: { 201: { description: "Template created" } },
        },
      },
      "/communication/emails": {
        post: {
          tags: ["Communication Platform"],
          summary: "Send enterprise transactional email",
          responses: { 200: { description: "Email dispatched" } },
        },
      },
      "/communication/sms": {
        post: {
          tags: ["Communication Platform"],
          summary: "Send direct SMS message",
          responses: { 200: { description: "SMS dispatched" } },
        },
      },
      "/communication/sms/otp/generate": {
        post: {
          tags: ["Communication Platform"],
          summary: "Generate and send OTP code via SMS",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { phone: { type: "string", example: "+1234567890" } } } } } },
          responses: { 200: { description: "OTP generated & sent" } },
        },
      },
      "/communication/sms/otp/verify": {
        post: {
          tags: ["Communication Platform"],
          summary: "Verify incoming SMS OTP code",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { phone: { type: "string" }, code: { type: "string", example: "123456" } } } } } },
          responses: { 200: { description: "OTP verified successfully" } },
        },
      },
      "/communication/sms/campaigns": {
        get: {
          tags: ["Communication Platform"],
          summary: "List bulk SMS marketing and notification campaigns",
          responses: { 200: { description: "Campaigns loaded" } },
        },
        post: {
          tags: ["Communication Platform"],
          summary: "Create a new bulk SMS campaign",
          responses: { 201: { description: "Campaign created" } },
        },
      },

      // =========================================================================
      // 9. ENTERPRISE FINANCE PLATFORM & ERP SUITE
      // =========================================================================
      "/accounts": {
        get: {
          tags: ["Finance - General Ledger & Accounts"],
          summary: "List Chart of Accounts",
          responses: { 200: { description: "Accounts listed" } },
        },
        post: {
          tags: ["Finance - General Ledger & Accounts"],
          summary: "Create a new General Ledger account",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateAccountRequest" } } } },
          responses: { 201: { description: "Account created" } },
        },
      },
      "/journals": {
        get: {
          tags: ["Finance - General Ledger & Accounts"],
          summary: "List General Journal entries",
          responses: { 200: { description: "Journals listed" } },
        },
        post: {
          tags: ["Finance - General Ledger & Accounts"],
          summary: "Create a new double-entry journal voucher",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateJournalRequest" } } } },
          responses: { 201: { description: "Journal created" } },
        },
      },
      "/journals/{journalId}/post": {
        post: {
          tags: ["Finance - General Ledger & Accounts"],
          summary: "Post journal to General Ledger",
          parameters: [{ name: "journalId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Journal posted to GL" } },
        },
      },
      "/general-ledger/trial-balance": {
        get: {
          tags: ["Finance - General Ledger & Accounts"],
          summary: "Generate Trial Balance report",
          responses: { 200: { description: "Trial balance returned" } },
        },
      },
      "/accounts-receivable": {
        get: {
          tags: ["Finance - Accounts Receivable & Collections"],
          summary: "List accounts receivable balances and aging",
          responses: { 200: { description: "AR records listed" } },
        },
        post: {
          tags: ["Finance - Accounts Receivable & Collections"],
          summary: "Create accounts receivable invoice entry",
          responses: { 201: { description: "AR entry created" } },
        },
      },
      "/customer-payments": {
        get: {
          tags: ["Finance - Accounts Receivable & Collections"],
          summary: "List customer collections & payment requests",
          responses: { 200: { description: "Collections loaded" } },
        },
        post: {
          tags: ["Finance - Accounts Receivable & Collections"],
          summary: "Create customer payment collection request",
          responses: { 201: { description: "Collection created" } },
        },
      },
      "/customer-payments/{collectionId}/collect": {
        post: {
          tags: ["Finance - Accounts Receivable & Collections"],
          summary: "Collect customer payment via gateway or card",
          parameters: [{ name: "collectionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Payment collected" } },
        },
      },
      "/customer-payments/{collectionId}/installments": {
        post: {
          tags: ["Finance - Accounts Receivable & Collections"],
          summary: "Create installment / payment plan schedule",
          parameters: [{ name: "collectionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 201: { description: "Installment plan created" } },
        },
      },
      "/accounts-payable": {
        get: {
          tags: ["Finance - Accounts Payable & Vendors"],
          summary: "List accounts payable invoices and dues",
          responses: { 200: { description: "Payables listed" } },
        },
        post: {
          tags: ["Finance - Accounts Payable & Vendors"],
          summary: "Create vendor payable invoice",
          responses: { 201: { description: "Payable created" } },
        },
      },
      "/vendors": {
        get: {
          tags: ["Finance - Accounts Payable & Vendors"],
          summary: "List vendors and suppliers",
          responses: { 200: { description: "Vendors listed" } },
        },
        post: {
          tags: ["Finance - Accounts Payable & Vendors"],
          summary: "Register a new vendor",
          responses: { 201: { description: "Vendor registered" } },
        },
      },
      "/invoices": {
        get: {
          tags: ["Finance - Invoices, Receipts & Notes"],
          summary: "List enterprise customer invoices",
          responses: { 200: { description: "Invoices listed" } },
        },
        post: {
          tags: ["Finance - Invoices, Receipts & Notes"],
          summary: "Create and issue an invoice",
          responses: { 201: { description: "Invoice created" } },
        },
      },
      "/invoices/{invoiceId}/issue": {
        post: {
          tags: ["Finance - Invoices, Receipts & Notes"],
          summary: "Issue invoice and post revenue to GL",
          parameters: [{ name: "invoiceId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Invoice issued" } },
        },
      },
      "/receipts": {
        get: {
          tags: ["Finance - Invoices, Receipts & Notes"],
          summary: "List payment receipts",
          responses: { 200: { description: "Receipts listed" } },
        },
      },
      "/credit-notes": {
        get: {
          tags: ["Finance - Invoices, Receipts & Notes"],
          summary: "List credit notes",
          responses: { 200: { description: "Credit notes listed" } },
        },
        post: {
          tags: ["Finance - Invoices, Receipts & Notes"],
          summary: "Create credit note",
          responses: { 201: { description: "Credit note created" } },
        },
      },
      "/debit-notes": {
        get: {
          tags: ["Finance - Invoices, Receipts & Notes"],
          summary: "List debit notes",
          responses: { 200: { description: "Debit notes listed" } },
        },
      },
      "/payments": {
        get: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "List all captured payments",
          responses: { 200: { description: "Payments listed" } },
        },
        post: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "Process a new payment",
          responses: { 201: { description: "Payment processed" } },
        },
      },
      "/wallets": {
        get: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "List customer digital wallets",
          responses: { 200: { description: "Wallets loaded" } },
        },
        post: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "Create customer wallet",
          responses: { 201: { description: "Wallet created" } },
        },
      },
      "/subscriptions": {
        get: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "List recurring subscriptions & memberships",
          responses: { 200: { description: "Subscriptions listed" } },
        },
        post: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "Create a subscription plan",
          responses: { 201: { description: "Subscription created" } },
        },
      },
      "/webhook-subscriptions": {
        get: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "List webhook event subscriptions",
          responses: { 200: { description: "Webhooks listed" } },
        },
        post: {
          tags: ["Finance - Payments, Wallets & Subscriptions"],
          summary: "Register a webhook endpoint",
          responses: { 201: { description: "Webhook registered" } },
        },
      },
      "/bank-accounts": {
        get: {
          tags: ["Finance - Banking & Reconciliation"],
          summary: "List enterprise bank accounts",
          responses: { 200: { description: "Bank accounts loaded" } },
        },
        post: {
          tags: ["Finance - Banking & Reconciliation"],
          summary: "Register a new corporate bank account",
          responses: { 201: { description: "Bank account created" } },
        },
      },
      "/bank-reconciliation": {
        get: {
          tags: ["Finance - Banking & Reconciliation"],
          summary: "List bank reconciliations",
          responses: { 200: { description: "Reconciliations listed" } },
        },
      },
      "/bank-reconciliation/{reconciliationId}/auto-match": {
        post: {
          tags: ["Finance - Banking & Reconciliation"],
          summary: "Run AI auto-matching for bank statement transactions",
          parameters: [{ name: "reconciliationId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Auto-match completed" } },
        },
      },
      "/cash-locations": {
        get: {
          tags: ["Finance - Banking & Reconciliation"],
          summary: "List cash drawers, safes & petty cash locations",
          responses: { 200: { description: "Cash locations listed" } },
        },
      },
      "/expenses": {
        get: {
          tags: ["Finance - Expenses & Vendor Payments"],
          summary: "List employee expense claims",
          responses: { 200: { description: "Expenses loaded" } },
        },
        post: {
          tags: ["Finance - Expenses & Vendor Payments"],
          summary: "Submit a new expense report",
          responses: { 201: { description: "Expense created" } },
        },
      },
      "/vendor-payments": {
        get: {
          tags: ["Finance - Expenses & Vendor Payments"],
          summary: "List vendor payments and disbursement proposals",
          responses: { 200: { description: "Vendor payments listed" } },
        },
        post: {
          tags: ["Finance - Expenses & Vendor Payments"],
          summary: "Create vendor payment proposal",
          responses: { 201: { description: "Proposal created" } },
        },
      },
      "/currencies/convert": {
        get: {
          tags: ["Finance - Currency, Tax & Pricing"],
          summary: "Real-time currency conversion using exchange rates",
          parameters: [
            { name: "from", in: "query", required: true, schema: { type: "string", example: "USD" } },
            { name: "to", in: "query", required: true, schema: { type: "string", example: "EUR" } },
            { name: "amount", in: "query", required: true, schema: { type: "number", example: 100 } },
          ],
          responses: { 200: { description: "Conversion calculated" } },
        },
      },
      "/currencies/revalue": {
        post: {
          tags: ["Finance - Currency, Tax & Pricing"],
          summary: "Run foreign currency balance sheet revaluation",
          responses: { 200: { description: "Revaluation completed" } },
        },
      },
      "/tax/calculate": {
        post: {
          tags: ["Finance - Currency, Tax & Pricing"],
          summary: "Calculate sales tax, VAT, and withholding tax for transaction",
          responses: { 200: { description: "Tax calculation returned" } },
        },
      },
      "/pricing/calculate": {
        post: {
          tags: ["Finance - Currency, Tax & Pricing"],
          summary: "Calculate dynamic price rules, volume discounts & coupon deductions",
          responses: { 200: { description: "Price calculation returned" } },
        },
      },
      "/approvals/start": {
        post: {
          tags: ["Finance - Approvals & Settlements"],
          summary: "Initiate multi-level financial approval request",
          responses: { 201: { description: "Approval request started" } },
        },
      },
      "/settlements": {
        get: {
          tags: ["Finance - Approvals & Settlements"],
          summary: "List payment gateway settlement batches",
          responses: { 200: { description: "Settlements listed" } },
        },
      },
      "/financial-reports/generate": {
        post: {
          tags: ["Finance - Reporting & Dashboards"],
          summary: "Generate Balance Sheet, P&L, or Cash Flow Report from General Ledger",
          responses: { 200: { description: "Report generated" } },
        },
      },
      "/financial-dashboard/executive": {
        get: {
          tags: ["Finance - Reporting & Dashboards"],
          summary: "Get CFO / Executive Financial Dashboard KPI summary",
          responses: { 200: { description: "Financial dashboard loaded" } },
        },
      },
      "/audit-events": {
        get: {
          tags: ["Finance - Audit, Treasury & Planning"],
          summary: "List immutable financial audit trail events",
          responses: { 200: { description: "Audit events listed" } },
        },
      },
      "/treasury/cash-position": {
        get: {
          tags: ["Finance - Audit, Treasury & Planning"],
          summary: "Get global enterprise cash position and bank liquidity",
          responses: { 200: { description: "Cash position loaded" } },
        },
      },
      "/budgets": {
        get: {
          tags: ["Finance - Audit, Treasury & Planning"],
          summary: "List enterprise operational and departmental budgets",
          responses: { 200: { description: "Budgets listed" } },
        },
        post: {
          tags: ["Finance - Audit, Treasury & Planning"],
          summary: "Create a new enterprise budget",
          responses: { 201: { description: "Budget created" } },
        },
      },
      "/finance-platform/health": {
        get: {
          tags: ["Finance - Audit, Treasury & Planning"],
          summary: "Health status of all ERP finance platform sub-engines",
          responses: { 200: { description: "Finance engine health check status" } },
        },
      },

      // =========================================================================
      // 10. INCIDENTS, ENTERPRISE SEARCH & REFERENCE DATA
      // =========================================================================
      "/incidents": {
        get: {
          tags: ["Incidents & SLA"],
          summary: "List enterprise incidents & SLA alerts",
          responses: { 200: { description: "Incidents loaded" } },
        },
        post: {
          tags: ["Incidents & SLA"],
          summary: "Report new incident",
          responses: { 201: { description: "Incident recorded" } },
        },
      },
      "/incidents/{incidentId}/escalate": {
        patch: {
          tags: ["Incidents & SLA"],
          summary: "Escalate incident severity and trigger alert notifications",
          parameters: [{ name: "incidentId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Incident escalated" } },
        },
      },
      "/search": {
        post: {
          tags: ["Enterprise Search"],
          summary: "Global unified cross-module search index query",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { query: { type: "string", example: "Alice Walker" } } } } } },
          responses: { 200: { description: "Search results returned" } },
        },
      },
      "/reference/airports": {
        get: {
          tags: ["Reference Data"],
          summary: "Get master airports reference catalog",
          responses: { 200: { description: "Airports list loaded" } },
        },
      },
      "/reference/currencies": {
        get: {
          tags: ["Reference Data"],
          summary: "Get supported currencies list",
          responses: { 200: { description: "Currencies list loaded" } },
        },
      },
      "/reference/countries": {
        get: {
          tags: ["Reference Data"],
          summary: "Get countries reference list",
          responses: { 200: { description: "Countries list loaded" } },
        },
      },
      "/notes": {
        get: {
          tags: ["Notes & Audit Timeline"],
          summary: "List system operational notes",
          responses: { 200: { description: "Notes loaded" } },
        },
        post: {
          tags: ["Notes & Audit Timeline"],
          summary: "Create a note entry",
          responses: { 201: { description: "Note created" } },
        },
      },
      "/timeline": {
        get: {
          tags: ["Notes & Audit Timeline"],
          summary: "List global system activity audit timeline",
          responses: { 200: { description: "Timeline loaded" } },
        },
      },
      "/integrations/amadeus/seat-maps": {
        post: {
          tags: ["Integrations (Amadeus & Airlines)"],
          summary: "Retrieve interactive aircraft seat map from Amadeus GDS",
          responses: { 200: { description: "Seat map data returned" } },
        },
      },
      "/integrations/amadeus/ancillary-services": {
        post: {
          tags: ["Integrations (Amadeus & Airlines)"],
          summary: "Get available ancillary services (extra baggage, meals)",
          responses: { 200: { description: "Ancillaries returned" } },
        },
      },
      "/integrations/airlines/check-in": {
        post: {
          tags: ["Integrations (Amadeus & Airlines)"],
          summary: "Direct airline flight check-in and boarding pass retrieval",
          responses: { 200: { description: "Check-in successful" } },
        },
      },
    },
  },
  apis: ["./routes/*.js", "./controllers/*.js"],
};

export const swaggerSpec = swaggerJSDoc(options);
