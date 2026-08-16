import test from "node:test";
import assert from "node:assert/strict";
import {
  isReceiptEligiblePayment,
  resolveReceiptParty,
  resolveContactForMethod,
  resolveStatusAfterDelivery
} from "../services/ReceiptService.js";

const ELIGIBLE = ["Captured", "Allocated", "Settled", "Completed"];

test("isReceiptEligiblePayment allows only funds-confirmed payment statuses", () => {
  assert.equal(isReceiptEligiblePayment("Captured", ELIGIBLE), true);
  assert.equal(isReceiptEligiblePayment("Settled", ELIGIBLE), true);
  assert.equal(isReceiptEligiblePayment("Initiated", ELIGIBLE), false);
  assert.equal(isReceiptEligiblePayment("Failed", ELIGIBLE), false);
});

test("resolveReceiptParty falls back to the payment's own party when no override is given", () => {
  const payment = { partyType: "customer", partyId: "cust-1" };
  assert.deepEqual(resolveReceiptParty(payment, {}), { partyType: "customer", partyId: "cust-1" });
});

test("resolveReceiptParty prefers an explicit override over the payment's own party", () => {
  const payment = { partyType: "customer", partyId: "cust-1" };
  assert.deepEqual(resolveReceiptParty(payment, { partyType: "vendor", partyId: "vendor-9" }), { partyType: "vendor", partyId: "vendor-9" });
});

test("resolveReceiptParty returns nulls when neither the payment nor an override has a party", () => {
  assert.deepEqual(resolveReceiptParty({ partyType: null, partyId: null }, {}), { partyType: null, partyId: null });
});

test("resolveContactForMethod picks email for Email and phone for WhatsApp/SMS", () => {
  const customer = { email: "a@example.com", phone: "+1000" };
  assert.equal(resolveContactForMethod("Email", customer), "a@example.com");
  assert.equal(resolveContactForMethod("WhatsApp", customer), "+1000");
  assert.equal(resolveContactForMethod("SMS", customer), "+1000");
});

test("resolveContactForMethod falls back to Vendor's contactEmail/contactPhone field names", () => {
  const vendor = { contactEmail: "v@example.com", contactPhone: "+2000" };
  assert.equal(resolveContactForMethod("Email", vendor), "v@example.com");
  assert.equal(resolveContactForMethod("WhatsApp", vendor), "+2000");
});

test("resolveContactForMethod returns null when there's no party document at all", () => {
  assert.equal(resolveContactForMethod("Email", null), null);
});

test("resolveStatusAfterDelivery stays Generated when no delivery was attempted", () => {
  assert.equal(resolveStatusAfterDelivery([]), "Generated");
});

test("resolveStatusAfterDelivery becomes Issued when delivery was attempted but nothing confirmed Sent", () => {
  assert.equal(resolveStatusAfterDelivery([{ method: "Email", status: "Failed" }, { method: "SMS", status: "NotConfigured" }]), "Issued");
});

test("resolveStatusAfterDelivery becomes Delivered as soon as one channel confirms Sent", () => {
  assert.equal(resolveStatusAfterDelivery([{ method: "Email", status: "Failed" }, { method: "WhatsApp", status: "Sent" }]), "Delivered");
});
