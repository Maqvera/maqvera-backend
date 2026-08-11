import express from "express";
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
import DBconfig from "./config/DbConfig.js";
import TravelOrchestrationEngine from "./services/TravelOrchestrationEngine.js";
import VisaTimelineEventBus from "./services/VisaTimelineEventBus.js";
import CustomerTimelineEventBus from "./services/CustomerTimelineEventBus.js";
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
import RefundService from "./services/RefundService.js";
import BankAccountService from "./services/BankAccountService.js";
import CustomerCollectionService from "./services/CustomerCollectionService.js";
import CustomerCollectionScheduler from "./services/customerCollectionScheduler.js";
import CurrencyRevaluationScheduler from "./services/currencyRevaluationScheduler.js";
import TaxRuleExpiryScheduler from "./services/taxRuleExpiryScheduler.js";
import PricingRuleExpiryScheduler from "./services/pricingRuleExpiryScheduler.js";
import ApprovalEscalationScheduler from "./services/approvalEscalationScheduler.js";
import FinancialReportScheduler from "./services/financialReportScheduler.js";
import AuditRetentionScheduler from "./services/auditRetentionScheduler.js";

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
  await CurrencyRevaluationScheduler.init();
  await TaxRuleExpiryScheduler.init();
  await PricingRuleExpiryScheduler.init();
  await ApprovalEscalationScheduler.init();
  await FinancialReportScheduler.init();
  await AuditRetentionScheduler.init();
  await AIWorkflowRecoveryScheduler.init();
  await AIContextExpiryScheduler.init();
  await AIApprovalTimeoutScheduler.init();
  await AIObservabilityAlertScheduler.init();
};

const app = express();

// Security & parsing (Disable CSP for Swagger UI compatibility)
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(compression());
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
    CustomerStatisticsEngine.init();
    AccountsReceivableService.initEventListeners();
    InvoiceService.initEventListeners();
    RefundService.initEventListeners();
    BankAccountService.initEventListeners();
    CustomerCollectionService.initEventListeners();
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (error) {
    console.error("Application bootstrap failed:", error.message);
    process.exitCode = 1;
  }
};

startServer();
