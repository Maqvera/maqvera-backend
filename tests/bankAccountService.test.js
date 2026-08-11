import test from "node:test";
import assert from "node:assert/strict";
import {
  isBankAccountVerifiable,
  isBankAccountActivatable,
  isBankAccountFreezable,
  isBankAccountReopenable,
  isBankAccountSuspendable,
  isBankAccountCloseable,
  isBankAccountArchivable,
  isBankAccountTransactable,
  resolvePaymentBankDirection
} from "../services/BankAccountService.js";
import { encryptField, decryptField, hashField, maskAccountNumber } from "../utils/fieldEncryption.js";

test("bank account status predicates follow the Pending Verification -> Verified -> Active gating", () => {
  assert.equal(isBankAccountVerifiable("Pending Verification"), true);
  assert.equal(isBankAccountVerifiable("Verified"), false);

  assert.equal(isBankAccountActivatable("Verified"), true);
  assert.equal(isBankAccountActivatable("Pending Verification"), false);

  assert.equal(isBankAccountFreezable("Active"), true);
  assert.equal(isBankAccountFreezable("Verified"), true);
  assert.equal(isBankAccountFreezable("Pending Verification"), false);

  assert.equal(isBankAccountReopenable("Frozen"), true);
  assert.equal(isBankAccountReopenable("Suspended"), true);
  assert.equal(isBankAccountReopenable("Active"), false);

  assert.equal(isBankAccountSuspendable("Active"), true);
  assert.equal(isBankAccountSuspendable("Frozen"), false);

  assert.equal(isBankAccountCloseable("Active"), true);
  assert.equal(isBankAccountCloseable("Frozen"), true);
  assert.equal(isBankAccountCloseable("Pending Verification"), false);

  assert.equal(isBankAccountArchivable("Closed"), true);
  assert.equal(isBankAccountArchivable("Active"), false);

  assert.equal(isBankAccountTransactable("Active"), true);
  assert.equal(isBankAccountTransactable("Frozen"), false);
  assert.equal(isBankAccountTransactable("Verified"), false);
});

test("resolvePaymentBankDirection credits the bank for customer-side money in, debits it for vendor-side money out", () => {
  assert.equal(resolvePaymentBankDirection("Customer"), "Credit");
  assert.equal(resolvePaymentBankDirection("Advance"), "Credit");
  assert.equal(resolvePaymentBankDirection("Deposit"), "Credit");
  assert.equal(resolvePaymentBankDirection("Vendor"), "Debit");
  assert.equal(resolvePaymentBankDirection("Employee"), "Debit");
});

test("encryptField/decryptField round-trips the original value", () => {
  process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || "test-encryption-key-for-unit-tests";
  const original = "PK123456789012345";
  const { encrypted, iv, authTag } = encryptField(original);
  assert.notEqual(encrypted, original);
  const decrypted = decryptField({ encrypted, iv, authTag });
  assert.equal(decrypted, original);
});

test("decryptField returns null for missing or malformed input", () => {
  assert.equal(decryptField({}), null);
  assert.equal(decryptField({ encrypted: "x", iv: "y", authTag: "z" }), null);
});

test("hashField is deterministic and normalizes case/whitespace", () => {
  assert.equal(hashField("abc123"), hashField(" ABC123 "));
  assert.notEqual(hashField("abc123"), hashField("abc124"));
});

test("maskAccountNumber shows only the last 4 characters", () => {
  assert.equal(maskAccountNumber("1234567890"), "******7890");
  assert.equal(maskAccountNumber("123"), "***");
  assert.equal(maskAccountNumber(""), "");
});
