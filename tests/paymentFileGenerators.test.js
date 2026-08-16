import test from "node:test";
import assert from "node:assert/strict";
import getPaymentFileGenerator from "../services/paymentFileGenerators/index.js";

const batchData = {
  batchNumber: "BATCH-2027-000001",
  paymentDate: new Date("2027-04-30"),
  currency: "USD",
  originator: {
    name: "MAQVERA TRAVEL LLC", taxId: "123456789", routingNumber: "021000021", accountNumber: "1234567890",
    iban: "GB29NWBK60161331926819", swiftBic: "NWBKGB2LXXX", bankName: "Example Bank"
  },
  payments: [
    { vendorName: "Acme Supplies", vendorTaxId: "987654321", amount: 1500.5, reference: "INV-2027-0001", bankAccount: { accountNumber: "555666777", routingNumber: "021000021", iban: "GB33BUKB20201555555555", swiftBic: "BUKBGB22XXX", bankName: "Vendor Bank", country: "GB" } },
    { vendorName: "Global Logistics", vendorTaxId: "111222333", amount: 2300, reference: "INV-2027-0002", bankAccount: { accountNumber: "888999000", routingNumber: "021000021", iban: "DE89370400440532013000", swiftBic: "COBADEFFXXX", bankName: "Vendor Bank 2", country: "DE" } }
  ]
};

test("getPaymentFileGenerator returns null for an unsupported format", () => {
  assert.equal(getPaymentFileGenerator("OpenBankingAPI"), null);
});

test("CSV generator produces one header row plus one row per payment", () => {
  const result = getPaymentFileGenerator("CSV").generate(batchData);
  const rows = result.content.split("\n");
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^Vendor,/);
  assert.match(rows[1], /Acme Supplies/);
  assert.equal(result.mimeType, "text/csv");
});

test("ACH (NACHA) generator produces exactly 94-character fixed-width records for every line", () => {
  const result = getPaymentFileGenerator("ACH").generate(batchData);
  const lines = result.content.split("\n");
  // File Header, Batch Header, 2 Entry Detail, Batch Control, File Control.
  assert.equal(lines.length, 6);
  for (const line of lines) assert.equal(line.length, 94, `expected 94 chars, got ${line.length}: "${line}"`);
  assert.equal(lines[0][0], "1"); // File Header
  assert.equal(lines[1][0], "5"); // Batch Header
  assert.equal(lines[2][0], "6"); // Entry Detail
  assert.equal(lines[3][0], "6"); // Entry Detail
  assert.equal(lines[4][0], "8"); // Batch Control
  assert.equal(lines[5][0], "9"); // File Control
});

test("ACH generator rejects a non-USD batch", () => {
  assert.throws(() => getPaymentFileGenerator("ACH").generate({ ...batchData, currency: "EUR" }), /USD/);
});

test("ACH generator requires the originator to have a routingNumber", () => {
  assert.throws(() => getPaymentFileGenerator("ACH").generate({ ...batchData, originator: { ...batchData.originator, routingNumber: null } }), /routingNumber/);
});

test("SEPA/ISO 20022 generator produces real pain.001 XML with one CdtTrfTxInf per payment", () => {
  const result = getPaymentFileGenerator("SEPA").generate(batchData);
  assert.match(result.content, /<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">/);
  assert.match(result.content, /<NbOfTxs>2<\/NbOfTxs>/);
  assert.equal((result.content.match(/<CdtTrfTxInf>/g) || []).length, 2);
  assert.match(result.content, /<IBAN>GB33BUKB20201555555555<\/IBAN>/);
  assert.equal(result.mimeType, "application/xml");

  // "ISO 20022" is the same real generator, not a parallel implementation.
  const isoResult = getPaymentFileGenerator("ISO 20022").generate(batchData);
  assert.match(isoResult.content, /<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">/);
});

test("SEPA generator requires the originator to have an IBAN", () => {
  assert.throws(() => getPaymentFileGenerator("SEPA").generate({ ...batchData, originator: { ...batchData.originator, iban: null } }), /IBAN/);
});

test("SWIFT MT generator produces one real MT103 block per payment with correct tags", () => {
  const result = getPaymentFileGenerator("SWIFT MT").generate(batchData);
  const messages = result.content.split("\n\n");
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.match(message, /^\{1:F01NWBKGB2LXXX0000000000\}/);
    assert.match(message, /\{2:I103[A-Z0-9]{11}N\}/);
    assert.match(message, /:20:/);
    assert.match(message, /:23B:CRED/);
    assert.match(message, /:32A:270430USD/);
    assert.match(message, /-\}$/);
  }
});

test("SWIFT MT generator requires the originator to have a swiftBic", () => {
  assert.throws(() => getPaymentFileGenerator("SWIFT MT").generate({ ...batchData, originator: { ...batchData.originator, swiftBic: null } }), /swiftBic/);
});
