import dotenv from "dotenv";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import express from "express";
import cors from "cors";
import customerRoute from "../routes/CustomerRoutes.js";
import bookingRoute from "../routes/BookingRoutes.js";
import DBconfig from "../config/Dbconfig.js";
import requestContext from "../middleware/requestContext.js";

dotenv.config();

const PORT = 5007;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestContext);
app.use(cors());

app.use("/api/v1/customers", customerRoute);
app.use("/api/v1/bookings", bookingRoute);

let server;

const token = jwt.sign(
  {
    id: "64f2a1b2c3d4e5f6a7b8c9d0",
    username: "TestBookingAdmin",
    name: "Booking Administrator",
    tenantId: "ALNOOR",
    permissions: [
      "customers.read", "customers.create", "customer.read", "customer.create",
      "booking.read", "booking.create", "booking.update", "booking.delete"
    ]
  },
  process.env.PRIVATE_KEY || "Python"
);

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${token}`
};

const runTest = async (name, fn) => {
  try {
    console.log(`\n--------------------------------------------------`);
    console.log(`RUNNING TEST: ${name}`);
    await fn();
    console.log(`✅ PASSED: ${name}`);
  } catch (err) {
    console.error(`❌ FAILED: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
};

const startServerAndRunTests = async () => {
  await DBconfig();
  server = app.listen(PORT, async () => {
    console.log(`Test server running at http://localhost:${PORT}`);
    
    let createdCustomerId = null;
    let createdBookingId = null;
    let createdBookingRef = null;

    const customerUrl = `http://localhost:${PORT}/api/v1/customers`;
    const bookingUrl = `http://localhost:${PORT}/api/v1/bookings`;

    // 1. Create a customer for booking
    await runTest("POST /api/v1/customers (Create Customer for Booking)", async () => {
      const payload = {
        firstName: "BookingCustomer",
        lastName: "Traveler",
        primaryEmail: `b_customer_${Date.now()}@example.com`,
        primaryPhone: `+923${Math.floor(100000000 + Math.random() * 900000000)}`,
        createAnyway: true
      };

      const res = await fetch(`${customerUrl}`, { method: "POST", headers, body: JSON.stringify(payload) });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));
      createdCustomerId = data.data.customerId;
    });

    // 2. Create Booking
    await runTest("POST /api/v1/bookings (Create Booking)", async () => {
      const payload = {
        customerId: createdCustomerId,
        bookingType: "umrah",
        travelDate: "2026-10-01",
        returnDate: "2026-10-15",
        totalAmount: 1500,
        currency: "USD",
        notes: "Initial Umrah Booking Request"
      };

      const res = await fetch(`${bookingUrl}`, { method: "POST", headers, body: JSON.stringify(payload) });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 201 || !data.data?._id) {
        throw new Error(`Failed to create booking: ${data.message}`);
      }

      createdBookingId = data.data._id;
      createdBookingRef = data.data.bookingReference;
    });

    // 3. List Bookings
    await runTest("GET /api/v1/bookings (List Bookings)", async () => {
      const res = await fetch(`${bookingUrl}?page=1&pageSize=10`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Bookings count:", data.data?.data?.length);

      if (res.status !== 200 || !Array.isArray(data.data?.data)) {
        throw new Error(`Failed to list bookings: ${data.message}`);
      }
    });

    // 4. Search Bookings
    await runTest("GET /api/v1/bookings/search (Search Bookings)", async () => {
      const res = await fetch(`${bookingUrl}/search?q=${createdBookingRef}`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Results count:", data.data?.length);

      if (res.status !== 200 || !Array.isArray(data.data)) {
        throw new Error(`Booking search failed: ${data.message}`);
      }
    });

    // 5. Get Booking Aggregate Profile
    await runTest("GET /api/v1/bookings/:bookingId (Get Booking Aggregate Profile)", async () => {
      const res = await fetch(`${bookingUrl}/${createdBookingId}`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Booking Ref:", data.data?.bookingReference, "Status:", data.data?.status);

      if (res.status !== 200 || data.data?._id !== createdBookingId) {
        throw new Error(`Get booking failed: ${data.message}`);
      }
    });

    // 6. Update Booking
    await runTest("PATCH /api/v1/bookings/:bookingId (Update Booking)", async () => {
      const payload = {
        totalAmount: 1800,
        notes: "Updated Umrah package with VIP transfer"
      };

      const res = await fetch(`${bookingUrl}/${createdBookingId}`, { method: "PATCH", headers, body: JSON.stringify(payload) });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200 || data.data?.totalAmount !== 1800) {
        throw new Error(`Update booking failed: ${data.message}`);
      }
    });

    // 7. Confirm Booking
    await runTest("POST /api/v1/bookings/:bookingId/confirm (Confirm Booking)", async () => {
      const res = await fetch(`${bookingUrl}/${createdBookingId}/confirm`, { method: "POST", headers, body: JSON.stringify({ reason: "Payment verified" }) });
      const data = await res.json();
      console.log("Status:", res.status, "Booking Status:", data.data?.status);

      if (res.status !== 200 || data.data?.status !== "confirmed") {
        throw new Error(`Confirm booking failed: ${data.message}`);
      }
    });

    // 8. Cancel Booking
    await runTest("POST /api/v1/bookings/:bookingId/cancel (Cancel Booking)", async () => {
      const res = await fetch(`${bookingUrl}/${createdBookingId}/cancel`, { method: "POST", headers, body: JSON.stringify({ reason: "Customer requested cancellation" }) });
      const data = await res.json();
      console.log("Status:", res.status, "Booking Status:", data.data?.status);

      if (res.status !== 200 || data.data?.status !== "cancelled") {
        throw new Error(`Cancel booking failed: ${data.message}`);
      }
    });

    // 9. Archive Booking
    await runTest("POST /api/v1/bookings/:bookingId/archive (Archive Booking)", async () => {
      const res = await fetch(`${bookingUrl}/${createdBookingId}/archive`, { method: "POST", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Archive booking failed: ${data.message}`);
      }
    });

    console.log(`\n==================================================`);
    console.log(`🎉 BOOKING FOUNDATION API TESTS COMPLETED SUCCESSFULLY!`);
    console.log(`==================================================\n`);

    server.close();
    await mongoose.disconnect();
    process.exit(process.exitCode || 0);
  });
};

startServerAndRunTests().catch(err => {
  console.error("Booking test error:", err);
  if (server) server.close();
  mongoose.disconnect();
  process.exit(1);
});
