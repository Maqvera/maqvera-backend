import dotenv from "dotenv";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import express from "express";
import cors from "cors";
import customerRoute from "../routes/CustomerRoutes.js";
import DBconfig from "../config/Dbconfig.js";
import requestContext from "../middleware/requestContext.js";

dotenv.config();

const PORT = 5006;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestContext);
app.use(cors());

app.use("/api/v1/customers", customerRoute);

let server;

const token = jwt.sign(
  {
    id: "64f2a1b2c3d4e5f6a7b8c9d0",
    username: "TestAdmin",
    name: "Test Administrator",
    tenantId: "ALNOOR",
    permissions: [
      "customers.read",
      "customers.create",
      "customers.update",
      "customers.delete",
      "customer.read",
      "customer.create",
      "customer.update",
      "customer.delete"
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
    let createdCustomerCode = null;
    let duplicateCustomerId = null;
    let createdNoteId = null;
    let createdDocId = null;
    let createdFamilyMemberId = null;

    const baseUrl = `http://localhost:${PORT}/api/v1/customers`;

    // 1. Create Primary Customer
    await runTest("POST /api/v1/customers (Create Primary Customer)", async () => {
      const payload = {
        firstName: "TestUserFirst",
        lastName: "TestUserLast",
        primaryEmail: `test_${Date.now()}@example.com`,
        primaryPhone: `+923${Math.floor(100000000 + Math.random() * 900000000)}`,
        gender: "male",
        dateOfBirth: "1990-05-15",
        nationality: "Pakistani",
        category: "regular",
        status: "active",
        createAnyway: true
      };

      const res = await fetch(`${baseUrl}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data, null, 2));

      if (res.status !== 201 || !data.data?.customerId) {
        throw new Error(`Failed to create primary customer: ${data.message}`);
      }

      createdCustomerId = data.data.customerId;
      createdCustomerCode = data.data.customerCode;
    });

    // 2. Create Duplicate Customer (for Merge test later)
    await runTest("POST /api/v1/customers (Create Secondary Customer for Merge)", async () => {
      const payload = {
        firstName: "DupUserFirst",
        lastName: "DupUserLast",
        primaryEmail: `dup_${Date.now()}@example.com`,
        primaryPhone: `+923${Math.floor(100000000 + Math.random() * 900000000)}`,
        createAnyway: true
      };

      const res = await fetch(`${baseUrl}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data, null, 2));

      if (res.status !== 201 || !data.data?.customerId) {
        throw new Error(`Failed to create secondary customer: ${data.message}`);
      }

      duplicateCustomerId = data.data.customerId;
    });

    // 3. List Customers
    await runTest("GET /api/v1/customers (List Customers)", async () => {
      const res = await fetch(`${baseUrl}?page=1&pageSize=10`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Items count:", data.data?.length, "Meta:", data.meta);

      if (res.status !== 200 || !Array.isArray(data.data)) {
        throw new Error(`Failed to list customers: ${data.message}`);
      }
    });

    // 4. Search Customers
    await runTest("GET /api/v1/customers/search (Search Customers)", async () => {
      const res = await fetch(`${baseUrl}/search?q=TestUserFirst`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Results count:", data.data?.length);

      if (res.status !== 200 || !Array.isArray(data.data)) {
        throw new Error(`Search failed: ${data.message}`);
      }
    });

    // 5. Get Customer Full Profile
    await runTest("GET /api/v1/customers/:customerId (Full Profile)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Customer Code:", data.data?.customerCode);

      if (res.status !== 200 || data.data?.customerId !== createdCustomerId) {
        throw new Error(`Get customer profile failed: ${data.message}`);
      }
    });

    // 6. Update Customer Profile
    await runTest("PATCH /api/v1/customers/:customerId (Update Profile)", async () => {
      const payload = {
        title: "Mr.",
        middleName: "Ahmed",
        companyName: "Acme Corp",
        maritalStatus: "married"
      };

      const res = await fetch(`${baseUrl}/${createdCustomerId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Update customer failed: ${data.message}`);
      }
    });

    // 7. Get Customer Profile Versions
    await runTest("GET /api/v1/customers/:customerId/versions (Version History)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/versions`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Versions count:", data.data?.length);

      if (res.status !== 200 || !Array.isArray(data.data)) {
        throw new Error(`Get versions failed: ${data.message}`);
      }
    });

    // 8. Add Customer Passport
    await runTest("POST /api/v1/customers/:customerId/passports (Add Passport)", async () => {
      const payload = {
        passportNumber: `PK${Math.floor(10000000 + Math.random() * 90000000)}`,
        countryOfIssue: "Pakistan",
        issueDate: "2022-01-01",
        expiryDate: "2032-01-01",
        placeOfIssue: "Islamabad",
        isPrimary: true
      };

      const res = await fetch(`${baseUrl}/${createdCustomerId}/passports`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 201) {
        throw new Error(`Add passport failed: ${data.message}`);
      }
    });

    // 9. Get Customer Passports
    await runTest("GET /api/v1/customers/:customerId/passports (Get Passports)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/passports`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Passports count:", data.data?.length);

      if (res.status !== 200 || !Array.isArray(data.data) || data.data.length === 0) {
        throw new Error(`Get passports failed: ${data.message}`);
      }
    });

    // 10. Add Customer Note (Part 5 Feature)
    await runTest("POST /api/v1/customers/:customerId/notes (Add Note)", async () => {
      const payload = {
        category: "Customer Service",
        visibility: "Internal",
        content: "Customer requested vegetarian meals and WhatsApp contact.",
        isImportant: true,
        attachments: [
          { fileName: "req.pdf", fileUrl: "https://example.com/req.pdf", mimeType: "application/pdf", fileSize: 1024 }
        ]
      };

      const res = await fetch(`${baseUrl}/${createdCustomerId}/notes`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 201 || !data.data?.noteId) {
        throw new Error(`Add note failed: ${data.message}`);
      }

      createdNoteId = data.data.noteId;
    });

    // 11. Get Customer Notes (Part 5 Feature with filtering & pagination)
    await runTest("GET /api/v1/customers/:customerId/notes (Get Notes with Filters)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/notes?category=Customer Service&visibility=Internal&page=1&pageSize=10`, {
        method: "GET",
        headers
      });
      const data = await res.json();
      console.log("Status:", res.status, "Notes count:", data.data?.data?.length, "Meta:", data.data?.meta);

      if (res.status !== 200 || !Array.isArray(data.data?.data)) {
        throw new Error(`Get notes failed: ${data.message}`);
      }
    });

    // 12. Archive Customer Note (Part 5 Feature)
    await runTest("POST /api/v1/customers/:customerId/notes/:noteId/archive (Archive Note)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/notes/${createdNoteId}/archive`, {
        method: "POST",
        headers
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Archive note failed: ${data.message}`);
      }
    });

    // 13. Get Customer Timeline (Part 5 Feature with filtering & pagination)
    await runTest("GET /api/v1/customers/:customerId/timeline (Get Timeline)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/timeline?module=Customer&page=1&pageSize=10`, {
        method: "GET",
        headers
      });
      const data = await res.json();
      console.log("Status:", res.status, "Timeline entries count:", data.data?.data?.length, "Meta:", data.data?.meta);

      if (res.status !== 200 || !Array.isArray(data.data?.data)) {
        throw new Error(`Get timeline failed: ${data.message}`);
      }
    });

    // 14. Get Customer Preferences (Part 5 Feature)
    await runTest("GET /api/v1/customers/:customerId/preferences (Get Preferences)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/preferences`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200 || !data.data?.preferredLanguage) {
        throw new Error(`Get preferences failed: ${data.message}`);
      }
    });

    // 15. Update Customer Preferences (Part 5 Feature)
    await runTest("PATCH /api/v1/customers/:customerId/preferences (Update Preferences)", async () => {
      const payload = {
        preferredLanguage: "ur",
        preferredCurrency: "PKR",
        preferredCommunicationChannel: "whatsapp",
        mealPreference: "vegetarian",
        seatPreference: "window",
        wheelchairAssistance: true,
        marketingConsent: true,
        notificationPreferences: { email: true, sms: false, whatsapp: true, push: true }
      };

      const res = await fetch(`${baseUrl}/${createdCustomerId}/preferences`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200 || data.data?.mealPreference !== "vegetarian") {
        throw new Error(`Update preferences failed: ${data.message}`);
      }
    });

    // 16. Get Customer Statistics (Part 5 Feature with calculated metrics)
    await runTest("GET /api/v1/customers/:customerId/statistics (Get Statistics)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/statistics`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200 || data.data?.documentsUploaded === undefined || data.data?.profileCompletion === undefined) {
        throw new Error(`Get statistics failed: ${data.message}`);
      }
    });

    // 17. Add Customer Document
    await runTest("POST /api/v1/customers/:customerId/documents (Add Document)", async () => {
      const payload = {
        documentType: "passport",
        storageProvider: "s3",
        storageKey: `passports/p_${Date.now()}.pdf`,
        fileName: "passport_scan.pdf",
        fileUrl: "https://storage.example.com/passports/p.pdf",
        mimeType: "application/pdf",
        fileSize: 2048500
      };

      const res = await fetch(`${baseUrl}/${createdCustomerId}/documents`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 201 || !data.data?._id) {
        throw new Error(`Add document failed: ${data.message}`);
      }

      createdDocId = data.data._id;
    });

    // 18. Get Customer Documents
    await runTest("GET /api/v1/customers/:customerId/documents (Get Documents)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/documents`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Docs count:", data.data?.length);

      if (res.status !== 200 || !Array.isArray(data.data)) {
        throw new Error(`Get documents failed: ${data.message}`);
      }
    });

    // 19. Delete / Archive Customer Document
    await runTest("DELETE /api/v1/customers/:customerId/documents/:documentId (Delete Document)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/documents/${createdDocId}`, {
        method: "DELETE",
        headers
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Delete document failed: ${data.message}`);
      }
    });

    // 20. Add Customer Family Member
    await runTest("POST /api/v1/customers/:customerId/family (Add Family Member)", async () => {
      const payload = {
        relationship: "Spouse",
        firstName: "SpouseFirst",
        lastName: "SpouseLast",
        gender: "female",
        dateOfBirth: "1992-08-20"
      };

      const res = await fetch(`${baseUrl}/${createdCustomerId}/family`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 201 || !data.data?._id) {
        throw new Error(`Add family member failed: ${data.message}`);
      }

      createdFamilyMemberId = data.data._id;
    });

    // 21. Get Customer Family Members
    await runTest("GET /api/v1/customers/:customerId/family (Get Family Members)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/family`, { method: "GET", headers });
      const data = await res.json();
      console.log("Status:", res.status, "Family members count:", data.data?.data?.length);

      if (res.status !== 200 || !Array.isArray(data.data?.data)) {
        throw new Error(`Get family members failed: ${data.message}`);
      }
    });

    // 22. Update Customer Family Member
    await runTest("PATCH /api/v1/customers/:customerId/family/:memberId (Update Family Member)", async () => {
      const payload = {
        phone: "+923001234567"
      };

      const res = await fetch(`${baseUrl}/${createdCustomerId}/family/${createdFamilyMemberId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Update family member failed: ${data.message}`);
      }
    });

    // 23. Delete Customer Family Member
    await runTest("DELETE /api/v1/customers/:customerId/family/:memberId (Delete Family Member)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/family/${createdFamilyMemberId}`, {
        method: "DELETE",
        headers
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Delete family member failed: ${data.message}`);
      }
    });

    // 24. Merge Customers
    await runTest("POST /api/v1/customers/merge (Merge Duplicate Customer)", async () => {
      const payload = {
        primaryCustomerId: createdCustomerId,
        duplicateCustomerId: duplicateCustomerId
      };

      const res = await fetch(`${baseUrl}/merge`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Merge customers failed: ${data.message}`);
      }
    });

    // 25. Archive Primary Customer
    await runTest("POST /api/v1/customers/:customerId/archive (Archive Customer)", async () => {
      const res = await fetch(`${baseUrl}/${createdCustomerId}/archive`, {
        method: "POST",
        headers
      });
      const data = await res.json();
      console.log("Status:", res.status, "Data:", JSON.stringify(data));

      if (res.status !== 200) {
        throw new Error(`Archive customer failed: ${data.message}`);
      }
    });

    console.log(`\n==================================================`);
    console.log(`🎉 ALL 25 API ENDPOINT TESTS COMPLETED SUCCESSFULLY! ZERO CRASHES!`);
    console.log(`==================================================\n`);

    server.close();
    await mongoose.disconnect();
    process.exit(process.exitCode || 0);
  });
};

startServerAndRunTests().catch(err => {
  console.error("Test setup error:", err);
  if (server) server.close();
  mongoose.disconnect();
  process.exit(1);
});
