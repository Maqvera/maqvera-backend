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

import route from "./routes/Authroute.js";
import customerRoute from "./routes/CustomerRoutes.js";
import userRoute from "./routes/UserRoutes.js";
import bookingRoute from "./routes/BookingRoutes.js";
import travelPlanRoute from "./routes/TravelPlanRoutes.js";
import incidentRoute from "./routes/IncidentRoutes.js";
import notesTimelineRoute from "./routes/NotesTimelineRoutes.js";
import dashboardRoute from "./routes/TravelDashboardRoutes.js";
import enterpriseSearchRoute from "./routes/EnterpriseSearchRoutes.js";
import flightSearchRoute from "./routes/FlightSearchRoutes.js";
import flightBookingRoute from "./routes/FlightBookingRoutes.js";
import hotelDistributionRoute from "./routes/HotelDistributionRoutes.js";
import visaRoute from "./routes/VisaRoutes.js";
import visaDashboardRoute from "./routes/VisaDashboardRoutes.js";
import DBconfig from "./config/DbConfig.js";
import TravelOrchestrationEngine from "./services/TravelOrchestrationEngine.js";
import VisaTimelineEventBus from "./services/VisaTimelineEventBus.js";
import CustomerTimelineEventBus from "./services/CustomerTimelineEventBus.js";
import CustomerStatisticsEngine from "./services/CustomerStatisticsEngine.js";
import VisaAnalyticsEngine from "./services/VisaAnalyticsEngine.js";
import CacheManager from "./utils/cacheManager.js";
import AnalyticsScheduler from "./services/analyticsScheduler.js";
import SearchEngineService from "./services/SearchEngineService.js";

validateEnv();

const bootstrapEnterpriseServices = async () => {
  await CacheManager.init();
  VisaAnalyticsEngine.init();
  SearchEngineService.init();
  await AnalyticsScheduler.init();
};

const app = express();

// Security & parsing
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
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

// Routes
app.use("/api/v1/auth", route);
app.use("/api/auth", route);
app.use("/api/v1/customers", customerRoute);
app.use("/api/v1/users", userRoute);
app.use("/api/v1/bookings", bookingRoute);
app.use("/api/v1/travel-plans", travelPlanRoute);
app.use("/api/v1/incidents", incidentRoute);
app.use("/api/v1/travel/dashboard", dashboardRoute);
app.use("/api/v1/dashboard", visaDashboardRoute);
app.use("/api/v1/search", enterpriseSearchRoute);
app.use("/api/v1/flight-search", flightSearchRoute);
app.use("/api/v1/flight-bookings", flightBookingRoute);
app.use("/api/v1", hotelDistributionRoute);
app.use("/api/v1", notesTimelineRoute);
app.use("/api/v1", visaRoute);

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
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (error) {
    console.error("Application bootstrap failed:", error.message);
    process.exitCode = 1;
  }
};

startServer();
