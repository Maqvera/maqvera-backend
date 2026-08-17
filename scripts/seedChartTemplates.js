import dotenv from "dotenv";
import mongoose from "mongoose";
import ChartTemplateModel from "../models/ChartTemplateModel.js";

// Seeds two real, tenant-agnostic (tenantId: null) Chart of Account
// templates — Part 36's own "GlobalTemplate" ownership case. Only two are
// seeded with real authority: a generic "Standard Business" chart, and a
// "Travel & Visa Agency" chart matching this ERP's own actual domain. The
// spec's own broader industry list (Restaurant, Hospital, Manufacturing,
// Construction, School, Logistics, Marketplace, Hospitality, Healthcare)
// is deliberately NOT seeded here — the applyTemplate mechanism (real,
// working) supports them the moment a domain expert defines their
// blueprints via POST /account-templates; fabricating unverified
// industry-specific chart-of-accounts structure for eight more industries
// this session has no real accounting authority over was not attempted
// (see docs/05-api/07-finance-api.md Part 36).
dotenv.config();
if (!process.env.URI) throw new Error("URI is required to seed Chart of Account templates.");

const standardBusinessId = () => "TPL-STANDARD-BUSINESS";
const travelAgencyId = () => "TPL-TRAVEL-VISA-AGENCY";

const standardBusiness = {
  templateId: standardBusinessId(),
  tenantId: null,
  name: "Standard Business",
  industry: "General",
  description: "A generic, reasonably complete starter Chart of Accounts for any small-to-mid-size business.",
  isSystemTemplate: true,
  status: "Active",
  accountBlueprints: [
    { accountCode: "1000", name: "Assets", category: "Assets", type: "Header" },
    { accountCode: "1100", name: "Current Assets", category: "Assets", type: "Header", parentAccountCode: "1000" },
    { accountCode: "1110", name: "Cash and Bank", category: "Assets", type: "Posting", parentAccountCode: "1100" },
    { accountCode: "1120", name: "Accounts Receivable", category: "Assets", type: "Control", parentAccountCode: "1100" },
    { accountCode: "1200", name: "Fixed Assets", category: "Assets", type: "Header", parentAccountCode: "1000" },
    { accountCode: "1210", name: "Equipment", category: "Assets", type: "Posting", parentAccountCode: "1200" },
    { accountCode: "2000", name: "Liabilities", category: "Liabilities", type: "Header" },
    { accountCode: "2100", name: "Current Liabilities", category: "Liabilities", type: "Header", parentAccountCode: "2000" },
    { accountCode: "2110", name: "Accounts Payable", category: "Liabilities", type: "Control", parentAccountCode: "2100" },
    { accountCode: "2120", name: "Accrued Expenses", category: "Liabilities", type: "Posting", parentAccountCode: "2100" },
    { accountCode: "3000", name: "Equity", category: "Equity", type: "Header" },
    { accountCode: "3100", name: "Owner's Equity", category: "Equity", type: "Posting", parentAccountCode: "3000" },
    { accountCode: "3200", name: "Retained Earnings", category: "Equity", type: "Posting", parentAccountCode: "3000" },
    { accountCode: "4000", name: "Revenue", category: "Revenue", type: "Header" },
    { accountCode: "4100", name: "Sales Revenue", category: "Revenue", type: "Posting", parentAccountCode: "4000" },
    { accountCode: "4200", name: "Service Revenue", category: "Revenue", type: "Posting", parentAccountCode: "4000" },
    { accountCode: "5000", name: "Expense", category: "Expense", type: "Header" },
    { accountCode: "5100", name: "Operating Expenses", category: "Expense", type: "Header", parentAccountCode: "5000" },
    { accountCode: "5110", name: "Salaries and Wages", category: "Expense", type: "Posting", parentAccountCode: "5100" },
    { accountCode: "5120", name: "Rent Expense", category: "Expense", type: "Posting", parentAccountCode: "5100" },
    { accountCode: "5130", name: "Utilities Expense", category: "Expense", type: "Posting", parentAccountCode: "5100" },
    { accountCode: "5140", name: "Office Supplies Expense", category: "Expense", type: "Posting", parentAccountCode: "5100" }
  ]
};

const travelVisaAgency = {
  templateId: travelAgencyId(),
  tenantId: null,
  name: "Travel & Visa Agency",
  industry: "Travel & Visa Services",
  description: "A starter Chart of Accounts for a travel/visa agency — matches this ERP's own real domain (Visa, Booking, Travel modules).",
  isSystemTemplate: true,
  status: "Active",
  accountBlueprints: [
    { accountCode: "1000", name: "Assets", category: "Assets", type: "Header" },
    { accountCode: "1110", name: "Cash and Bank", category: "Assets", type: "Posting", parentAccountCode: "1000" },
    { accountCode: "1120", name: "Accounts Receivable — Customers", category: "Assets", type: "Control", parentAccountCode: "1000" },
    { accountCode: "1130", name: "Prepaid Airline Deposits", category: "Assets", type: "Posting", parentAccountCode: "1000" },
    { accountCode: "2000", name: "Liabilities", category: "Liabilities", type: "Header" },
    { accountCode: "2110", name: "Accounts Payable — Vendors", category: "Liabilities", type: "Control", parentAccountCode: "2000" },
    { accountCode: "2120", name: "Customer Advances / Deposits", category: "Liabilities", type: "Posting", parentAccountCode: "2000" },
    { accountCode: "2130", name: "Employee Reimbursement Payable", category: "Liabilities", type: "Posting", parentAccountCode: "2000" },
    { accountCode: "3000", name: "Equity", category: "Equity", type: "Header" },
    { accountCode: "3100", name: "Owner's Equity", category: "Equity", type: "Posting", parentAccountCode: "3000" },
    { accountCode: "3200", name: "Retained Earnings", category: "Equity", type: "Posting", parentAccountCode: "3000" },
    { accountCode: "4000", name: "Revenue", category: "Revenue", type: "Header" },
    { accountCode: "4110", name: "Visa Processing Fee Revenue", category: "Revenue", type: "Posting", parentAccountCode: "4000" },
    { accountCode: "4120", name: "Travel Booking Commission Revenue", category: "Revenue", type: "Posting", parentAccountCode: "4000" },
    { accountCode: "4130", name: "Air Ticket Revenue", category: "Revenue", type: "Posting", parentAccountCode: "4000" },
    { accountCode: "4140", name: "Hotel Booking Revenue", category: "Revenue", type: "Posting", parentAccountCode: "4000" },
    { accountCode: "4150", name: "Travel Insurance Commission", category: "Revenue", type: "Posting", parentAccountCode: "4000" },
    { accountCode: "5000", name: "Expense", category: "Expense", type: "Header" },
    { accountCode: "5110", name: "Visa Processing Expense", category: "Expense", type: "Posting", parentAccountCode: "5000" },
    { accountCode: "5120", name: "Airline Ticketing Charges", category: "Expense", type: "Posting", parentAccountCode: "5000" },
    { accountCode: "5130", name: "Marketing and Advertising", category: "Expense", type: "Posting", parentAccountCode: "5000" },
    { accountCode: "5140", name: "Salaries and Wages", category: "Expense", type: "Posting", parentAccountCode: "5000" },
    { accountCode: "5150", name: "Office Rent Expense", category: "Expense", type: "Posting", parentAccountCode: "5000" },
    { accountCode: "5160", name: "Employee Travel Expense", category: "Expense", type: "Posting", parentAccountCode: "5000" }
  ]
};

await mongoose.connect(process.env.URI);
for (const template of [standardBusiness, travelVisaAgency]) {
  await ChartTemplateModel.findOneAndUpdate(
    { templateId: template.templateId },
    template,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`Chart template "${template.name}" (${template.templateId}) seeded — ${template.accountBlueprints.length} account blueprints.`);
}
await mongoose.disconnect();
