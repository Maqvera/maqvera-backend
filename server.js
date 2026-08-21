import express from "express";
import http from "http";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";

dotenv.config();

import { validateEnv } from "./config/envValidator.js";
import { requestLogger } from "./utils/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import requestContext from "./middleware/requestContext.js";
import swaggerUi from "swagger-ui-express";
import { dump as dumpYaml } from "js-yaml";
import { swaggerSpec } from "./config/swaggerConfig.js";

import route from "./routes/Authroute.js";
import customerRoute from "./routes/CustomerRoutes.js";
import userRoute from "./routes/UserRoutes.js";
import roleRoute from "./routes/RoleRoutes.js";
import bookingRoute from "./routes/BookingRoutes.js";
import travelPlanRoute from "./routes/TravelPlanRoutes.js";
import incidentRoute from "./routes/IncidentRoutes.js";
import notesTimelineRoute from "./routes/NotesTimelineRoutes.js";
import dashboardRoute from "./routes/TravelDashboardRoutes.js";
import enterpriseSearchRoute from "./routes/EnterpriseSearchRoutes.js";
import flightSearchRoute from "./routes/FlightSearchRoutes.js";
import flightBookingRoute from "./routes/FlightBookingRoutes.js";
import aiAssistantRoute from "./routes/AIAssistantRoutes.js";
import aiOrchestrationRoute from "./routes/AIOrchestrationRoutes.js";
import aiKnowledgeRoute from "./routes/AIKnowledgeRoutes.js";
import aiPromptRoute from "./routes/AIPromptRoutes.js";
import aiGuardrailRoute from "./routes/AIGuardrailRoutes.js";
import aiObservabilityRoute from "./routes/AIObservabilityRoutes.js";
import aiModelRouterRoute from "./routes/AIModelRouterRoutes.js";
import externalFlightRoute from "./routes/ExternalFlightRoutes.js";
import externalAmadeusRoute from "./routes/ExternalAmadeusRoutes.js";
import amadeusIntegrationRoute from "./routes/AmadeusIntegrationRoutes.js";
import airlineIntegrationRoute from "./routes/AirlineIntegrationRoutes.js";
import hotelDistributionRoute from "./routes/HotelDistributionRoutes.js";
import visaRoute from "./routes/VisaRoutes.js";
import visaDashboardRoute from "./routes/VisaDashboardRoutes.js";
import referenceDataRoute from "./routes/ReferenceDataRoutes.js";
import financeRoute from "./routes/FinanceRoutes.js";
import packageRoute from "./routes/PackageRoutes.js";
import subscriptionPlatformRoute from "./routes/SubscriptionPlatformRoutes.js";
import subscriptionResourceRoute from "./routes/SubscriptionResourceRoutes.js";
import merchantPlatformRoute from "./routes/MerchantPlatformRoutes.js";
import organisationRoute from "./routes/OrganisationRoutes.js";
import numberingRoute from "./routes/NumberingRoutes.js";
import tenantProfileRoute from "./routes/TenantProfileRoutes.js";
import resilienceRoute from "./routes/ResilienceRoutes.js";
import eventRegistryRoute from "./routes/EventRegistryRoutes.js";
import apiVersionRegistryRoute from "./routes/ApiVersionRegistryRoutes.js";
import rateLimitRoute from "./routes/RateLimitRoutes.js";
import communicationRoute from "./routes/CommunicationRoutes.js";
import paymentGatewayRoute from "./routes/PaymentGatewayRoutes.js";
import paymentWebhookRoute from "./routes/PaymentWebhookRoutes.js";
import DBconfig from "./config/DbConfig.js";
import TravelOrchestrationEngine from "./services/TravelOrchestrationEngine.js";
import VisaTimelineEventBus from "./services/VisaTimelineEventBus.js";
import CustomerTimelineEventBus from "./services/CustomerTimelineEventBus.js";
import PaymentNotificationListener from "./services/paymentNotificationListener.js";
import CustomerStatisticsEngine from "./services/CustomerStatisticsEngine.js";
import VisaAnalyticsEngine from "./services/VisaAnalyticsEngine.js";
import CacheManager from "./utils/cacheManager.js";
import AnalyticsScheduler from "./services/analyticsScheduler.js";
import DocumentExpiryScheduler from "./services/documentExpiryScheduler.js";
import SearchEngineService from "./services/SearchEngineService.js";
import EmbassyProcessingService from "./services/EmbassyProcessingService.js";
import AppointmentReminderScheduler from "./services/appointmentReminderScheduler.js";
import IncidentSlaScheduler from "./services/incidentSlaScheduler.js";
import ReferenceDataScheduler from "./services/referenceDataScheduler.js";
import FlightScheduleSyncScheduler from "./services/flightScheduleSyncScheduler.js";
import AIWorkflowRecoveryScheduler from "./services/aiWorkflowRecoveryScheduler.js";
import AIContextExpiryScheduler from "./services/aiContextExpiryScheduler.js";
import AIApprovalTimeoutScheduler from "./services/aiApprovalTimeoutScheduler.js";
import AIObservabilityAlertScheduler from "./services/aiObservabilityAlertScheduler.js";
import ReceivableOverdueScheduler from "./services/receivableOverdueScheduler.js";
import AccountsReceivableService from "./services/AccountsReceivableService.js";
import InvoiceService from "./services/InvoiceService.js";
import BookingFinanceLinkService from "./services/BookingFinanceLinkService.js";
import VisaFinanceLinkService from "./services/VisaFinanceLinkService.js";
import VisaCommunicationListener from "./services/VisaCommunicationListener.js";
import { closeBrowser as closeHtmlPdfBrowser } from "./services/HtmlPdfRenderer.js";
import { attachVoiceBookingWebSocketServer } from "./services/BookingVoiceSocketServer.js";
import RefundService from "./services/RefundService.js";
import BankAccountService from "./services/BankAccountService.js";
import CustomerCollectionService from "./services/CustomerCollectionService.js";
import WebhookService from "./services/WebhookService.js";
import CustomerCollectionScheduler from "./services/customerCollectionScheduler.js";
import SubscriptionBillingScheduler from "./services/subscriptionBillingScheduler.js";
import CurrencyRevaluationScheduler from "./services/currencyRevaluationScheduler.js";
import TenantSubscriptionScheduler from "./services/tenantSubscriptionScheduler.js";
import SubscriptionSuspensionEnforcementScheduler from "./services/subscriptionSuspensionEnforcementScheduler.js";
import SubscriptionRenewalEngineScheduler from "./services/subscriptionRenewalEngineScheduler.js";
import PaymentRetryEngineScheduler from "./services/paymentRetryEngineScheduler.js";
import TaxRuleExpiryScheduler from "./services/taxRuleExpiryScheduler.js";
import PricingRuleExpiryScheduler from "./services/pricingRuleExpiryScheduler.js";
import ApprovalEscalationScheduler from "./services/approvalEscalationScheduler.js";
import FinancialReportScheduler from "./services/financialReportScheduler.js";
import AuditRetentionScheduler from "./services/auditRetentionScheduler.js";
import WebhookRetryScheduler from "./services/webhookRetryScheduler.js";
import RecurringJournalScheduler from "./services/recurringJournalScheduler.js";
import MuharramPeriodScheduler from "./services/muharramPeriodScheduler.js";

validateEnv();

const bootstrapEnterpriseServices = async () => {
  await CacheManager.init();
  VisaAnalyticsEngine.init();
  SearchEngineService.init();
  EmbassyProcessingService.init();
  await AnalyticsScheduler.init();
  await DocumentExpiryScheduler.init();
  await AppointmentReminderScheduler.init();
  await IncidentSlaScheduler.init();
  await ReferenceDataScheduler.init();
  await FlightScheduleSyncScheduler.init();
  await ReceivableOverdueScheduler.init();
  await CustomerCollectionScheduler.init();
  await SubscriptionBillingScheduler.init();
  await CurrencyRevaluationScheduler.init();
  await TaxRuleExpiryScheduler.init();
  await PricingRuleExpiryScheduler.init();
  await ApprovalEscalationScheduler.init();
  await FinancialReportScheduler.init();
  await AuditRetentionScheduler.init();
  await WebhookRetryScheduler.init();
  await RecurringJournalScheduler.init();
  await AIWorkflowRecoveryScheduler.init();
  await AIContextExpiryScheduler.init();
  await AIApprovalTimeoutScheduler.init();
  await AIObservabilityAlertScheduler.init();
  await TenantSubscriptionScheduler.init();
  await SubscriptionSuspensionEnforcementScheduler.init();
  await SubscriptionRenewalEngineScheduler.init();
  await PaymentRetryEngineScheduler.init();
  await MuharramPeriodScheduler.init();
};

const app = express();

// Security & parsing (Disable CSP for Swagger UI compatibility)
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(compression());

// Per-Tenant Payment Gateway Integration — Stripe webhook signature
// verification needs the RAW, unparsed request body. Must be mounted
// BEFORE the global `express.json()` below (or the raw body is gone by
// the time the webhook route sees it, and signature verification always
// fails) — `express.raw()` is scoped to exactly this one path, so every
// other route's JSON body parsing is completely unaffected.
app.use("/api/v1/webhooks", express.raw({ type: "application/json" }), paymentWebhookRoute);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173", credentials: true }));

// Request context & logging
app.use(requestContext);
app.use(requestLogger);

// Static files for local uploads
app.use("/uploads", express.static("uploads"));

// Health Check — real, not a fixed 200: checks the two actual runtime
// dependencies every request downstream relies on.
app.get("/health", async (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  const cacheHealthy = await CacheManager.isHealthy();
  const healthy = dbConnected && cacheHealthy;
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    checks: {
      database: dbConnected ? "up" : "down",
      cache: { backend: CacheManager.backendName, status: cacheHealthy ? "up" : "down" }
    },
    timestamp: new Date().toISOString()
  });
});

// Swagger OpenAPI Documentation
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));

// Enterprise OpenAPI / Swagger / SDK Generation Standard (Enterprise
// Architecture Hardening Phase, Improvement 15). "Every API should expose
// /openapi.json or /openapi.yaml. This becomes the single source of
// truth." Both serialize the SAME `swaggerSpec` object `/api-docs`
// already renders — one real source, two formats, never a second,
// hand-maintained copy. Public/unauthenticated, same as `/api-docs`
// itself — the machine-readable contract is offered at the same access
// level as its human-readable rendering.
app.get("/openapi.json", (req, res) => res.status(200).json(swaggerSpec));
app.get("/openapi.yaml", (req, res) => {
  res.status(200).type("text/yaml").send(dumpYaml(swaggerSpec));
});

// Routes
app.use("/api/v1/auth", route);
app.use("/api/auth", route);
app.use("/api/v1/customers", customerRoute);
app.use("/api/v1/users", userRoute);
app.use("/api/v1/roles", roleRoute);
app.use("/api/v1/bookings", bookingRoute);
app.use("/api/v1/travel-plans", travelPlanRoute);
app.use("/api/v1/incidents", incidentRoute);
app.use("/api/v1/travel/dashboard", dashboardRoute);
app.use("/api/v1/dashboard", visaDashboardRoute);
app.use("/api/v1/search", enterpriseSearchRoute);
app.use("/api/v1/flight-search", flightSearchRoute);
app.use("/api/v1/flight-bookings", flightBookingRoute);
app.use("/api/v1", hotelDistributionRoute);
app.use("/api/v1/ai", aiAssistantRoute);
app.use("/api/v1/ai", aiOrchestrationRoute);
app.use("/api/v1/ai/knowledge", aiKnowledgeRoute);
app.use("/api/v1/ai/prompts", aiPromptRoute);
app.use("/api/v1/ai/guardrails", aiGuardrailRoute);
app.use("/api/v1/ai/observability", aiObservabilityRoute);
app.use("/api/v1/ai/models", aiModelRouterRoute);
app.use("/api/v1/external", externalFlightRoute);
app.use("/api/v1/external/amadeus", externalAmadeusRoute);
app.use("/api/v1/integrations/amadeus", amadeusIntegrationRoute);
app.use("/api/v1/integrations/airlines", airlineIntegrationRoute);
app.use("/api/v1/reference", referenceDataRoute);
app.use("/api/v1", notesTimelineRoute);
app.use("/api/v1", visaRoute);
app.use("/api/v1", financeRoute);
app.use("/api/v1/packages", packageRoute);
app.use("/api/v1/platform", subscriptionPlatformRoute);
app.use("/api/v1/subscriptions", subscriptionResourceRoute);
app.use("/api/v1", merchantPlatformRoute);
app.use("/api/v1", organisationRoute);
app.use("/api/v1/numbering", numberingRoute);
app.use("/api/v1/tenant-profile", tenantProfileRoute);
app.use("/api/v1/resilience", resilienceRoute);
app.use("/api/v1/event-registry", eventRegistryRoute);
app.use("/api/v1/api-version-registry", apiVersionRegistryRoute);
app.use("/api/v1/rate-limits", rateLimitRoute);
app.use("/api/v1/communication", communicationRoute);
app.use("/api/v1/emails", communicationRoute);
app.use("/api/v1/sms", communicationRoute);
app.use("/api/v1/payment-gateways", paymentGatewayRoute);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || "7000";
const startServer = async () => {
  try {
    await DBconfig();
    await bootstrapEnterpriseServices();
    TravelOrchestrationEngine.init();
    VisaTimelineEventBus.init();
    CustomerTimelineEventBus.init();
    PaymentNotificationListener.init();
    CustomerStatisticsEngine.init();
    AccountsReceivableService.initEventListeners();
    InvoiceService.initEventListeners();
    BookingFinanceLinkService.initEventListeners();
    VisaFinanceLinkService.initEventListeners();
    VisaCommunicationListener.initEventListeners();
    RefundService.initEventListeners();
    BankAccountService.initEventListeners();
    CustomerCollectionService.initEventListeners();
    WebhookService.initEventListeners();

    // Voice-Based Booking Creation PRD B4.4/Step 3 — Express itself cannot
    // handle a WebSocket upgrade, so the bare `app.listen(PORT)` this
    // codebase previously had (verified — no existing http.createServer
    // wrapper before this change) becomes an explicit http.Server that
    // both Express and the Mode B voice-session WS endpoint attach to.
    // Every scheduler/event-listener .init() above still runs first,
    // unchanged in order.
    const httpServer = http.createServer(app);
    attachVoiceBookingWebSocketServer(httpServer);
    httpServer.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (error) {
    console.error("Application bootstrap failed:", error.message);
    process.exitCode = 1;
  }
};

startServer();

// PRD "HTML-Template PDF Architecture Migration" Issue 2b — this codebase
// had no existing SIGTERM/graceful-shutdown handler to append to (verified
// by grep across every *.js file before adding this), so this is a new,
// standalone hook, not an addition to something pre-existing. Releases the
// shared headless-Chromium process HtmlPdfRenderer.js lazily launches, so a
// container restart/redeploy doesn't leave an orphaned Chromium process.
process.on("SIGTERM", async () => {
  console.log("SIGTERM received — closing shared Puppeteer browser instance.");
  await closeHtmlPdfBrowser().catch((err) => console.error("Failed to close Puppeteer browser on shutdown:", err.message));
  process.exit(0);
});
