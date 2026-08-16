import test from "node:test";
import assert from "node:assert/strict";
import getStatementParser from "../services/reconciliationParsers/index.js";

test("getStatementParser returns null for an unsupported format", () => {
  assert.equal(getStatementParser("OpenBankingAPI"), null);
});

test("CSV parser extracts transactions from debit/credit columns", async () => {
  const csv = "Date,Description,Debit,Credit\n2027-01-05,Cheque 001 cleared,1500.00,\n2027-01-10,Customer deposit,,5000.00\n";
  const result = await getStatementParser("CSV").parse(Buffer.from(csv, "utf8"));
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].direction, "Debit");
  assert.equal(result.transactions[0].amount, 1500);
  assert.equal(result.transactions[1].direction, "Credit");
  assert.equal(result.transactions[1].amount, 5000);
});

test("CSV parser throws when no recognizable transaction rows exist", async () => {
  const csv = "Foo,Bar\n1,2\n";
  await assert.rejects(() => getStatementParser("CSV").parse(Buffer.from(csv, "utf8")), /No recognizable transactions/);
});

test("MT940 parser extracts opening/closing balance and transaction lines from real tag grammar", async () => {
  const mt940 = [
    ":20:STMT0001",
    ":25:1234567890",
    ":28C:1/1",
    ":60F:C270101PKR100000,00",
    ":61:2701050105D1500,00NMSCREF001",
    ":86:Cheque 001 cleared",
    ":61:2701100110C5000,00NTRFREF002//BANKREF002",
    ":86:Customer deposit",
    ":62F:C270131PKR103500,00"
  ].join("\r\n");
  const result = await getStatementParser("MT940").parse(Buffer.from(mt940, "utf8"));
  assert.equal(result.openingBalance, 100000);
  assert.equal(result.closingBalance, 103500);
  assert.equal(result.currency, "PKR");
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].direction, "Debit");
  assert.equal(result.transactions[0].amount, 1500);
  assert.ok(result.transactions[0].reference.includes("Cheque 001 cleared"));
  assert.equal(result.transactions[1].direction, "Credit");
  assert.equal(result.transactions[1].amount, 5000);
});

test("CAMT.053 parser extracts OPBD/CLBD balances and Ntry entries from real ISO20022 XML", async () => {
  const camt = `<?xml version="1.0"?>
<Document>
  <BkToCstmrStmt>
    <Stmt>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="PKR">100000.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt><Dt>2027-01-01</Dt></Dt>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="PKR">103500.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt><Dt>2027-01-31</Dt></Dt>
      </Bal>
      <Ntry>
        <Amt Ccy="PKR">1500.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2027-01-05</Dt></BookgDt>
        <NtryRef>REF001</NtryRef>
        <AddtlNtryInf>Cheque 001 cleared</AddtlNtryInf>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
  const result = await getStatementParser("CAMT.053").parse(Buffer.from(camt, "utf8"));
  assert.equal(result.openingBalance, 100000);
  assert.equal(result.closingBalance, 103500);
  assert.equal(result.currency, "PKR");
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].direction, "Debit");
  assert.equal(result.transactions[0].amount, 1500);
  assert.equal(result.transactions[0].externalTransactionId, "REF001");
});

test("OFX parser extracts STMTTRN blocks and treats BALAMT as the closing balance", async () => {
  const ofx = [
    "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "",
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
    "<CURDEF>PKR",
    "<BANKTRANLIST>",
    "<STMTTRN>", "<TRNTYPE>DEBIT", "<DTPOSTED>20270105", "<TRNAMT>-1500.00", "<FITID>FIT001", "<NAME>Cheque 001 cleared", "</STMTTRN>",
    "<STMTTRN>", "<TRNTYPE>CREDIT", "<DTPOSTED>20270110", "<TRNAMT>5000.00", "<FITID>FIT002", "<NAME>Customer deposit", "</STMTTRN>",
    "</BANKTRANLIST>",
    "<LEDGERBAL><BALAMT>103500.00", "<DTASOF>20270131", "</LEDGERBAL>",
    "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"
  ].join("\n");
  const result = await getStatementParser("OFX").parse(Buffer.from(ofx, "utf8"));
  assert.equal(result.closingBalance, 103500);
  assert.equal(result.currency, "PKR");
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].direction, "Debit");
  assert.equal(result.transactions[0].amount, 1500);
  assert.equal(result.transactions[1].direction, "Credit");
  assert.equal(result.transactions[1].amount, 5000);
});

test("Custom JSON parser validates required fields and rejects an invalid direction", async () => {
  const good = JSON.stringify({ currency: "PKR", openingBalance: 100000, closingBalance: 103500, transactions: [{ transactionDate: "2027-01-05", direction: "Debit", amount: 1500 }] });
  const result = await getStatementParser("Custom").parse(Buffer.from(good, "utf8"));
  assert.equal(result.transactions.length, 1);
  assert.equal(result.currency, "PKR");

  const bad = JSON.stringify({ transactions: [{ transactionDate: "2027-01-05", direction: "Sideways", amount: 1500 }] });
  await assert.rejects(() => getStatementParser("Custom").parse(Buffer.from(bad, "utf8")), /invalid direction/);
});
