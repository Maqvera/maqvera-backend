import dotenv from "dotenv";
import mongoose from "mongoose";
import ReportCatalogService from "../services/ReportCatalogService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

dotenv.config();
if (!process.env.URI || !process.env.SEED_TENANT_ID) throw new Error("URI and SEED_TENANT_ID are required.");
await mongoose.connect(process.env.URI);

// Reporting Platform Part 2 fix — one catalog entry per report type
// services/FinancialReportService.js already validates and generates
// (config.reportTypes, from utils/financeConfig.js's reportTypes) — these
// are already live/validated in production use, so they're registered as
// "published" from day one rather than invented report types starting at
// "draft".
const financeConfig = getFinanceConfig();

const NAME_OVERRIDES = {
  TrialBalance: "Trial Balance",
  BalanceSheet: "Balance Sheet",
  ProfitAndLoss: "Profit and Loss",
  CashFlow: "Cash Flow Statement",
  GeneralLedger: "General Ledger",
  JournalRegister: "Journal Register",
  ARAging: "Accounts Receivable Aging",
  APAging: "Accounts Payable Aging",
  TaxReport: "Tax Report",
  BudgetVsActual: "Budget vs Actual",
  RetainedEarnings: "Retained Earnings",
  Custom: "Custom Report"
};

let seeded = 0;
for (const reportType of financeConfig.reportTypes) {
  await ReportCatalogService.registerCatalogEntry({
    tenantId: process.env.SEED_TENANT_ID,
    reportKey: reportType,
    name: NAME_OVERRIDES[reportType] || reportType,
    module: "Finance",
    category: "Financial Statements",
    lifecycleState: "published"
  });
  seeded += 1;
}

await mongoose.disconnect();
console.log(`Report catalog seeded for tenant ${process.env.SEED_TENANT_ID} (${seeded} entries).`);
