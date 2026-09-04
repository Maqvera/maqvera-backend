import CustomerModel from "../models/CustomerModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import CurrencyService from "./CurrencyService.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Customer Account Statement — booking-module PRD item #10. Deliberately
 * built entirely from real AccountsReceivableModel records (via
 * BookingFinanceLinkService's Booking -> Invoice -> Receivable wiring,
 * item #6), never from BookingHeaderModel.financialSnapshot directly —
 * "Finance must remain the source of truth, no second ledger" was the
 * explicit product decision this feature was built against. One
 * consequence: a booking created before that wiring existed (or a $0
 * booking that never had anything to bill) has no receivable and will not
 * appear as a statement row — it still appears in the customer's plain
 * booking list (GetCustomerBookings), just not here, since there is
 * nothing real to report financially for it.
 *
 * Row granularity is one row per booking/receivable (matching the source
 * requirement doc's own worked examples, e.g. "Booking REF-1001: Debit
 * 2,440, Credit 1,000, Balance 1,440"), not a running ledger balance
 * across unrelated bookings — the doc never specifies that semantics, and
 * fabricating one would be guessing. Debit/Credit/Balance are each row's
 * own receivable amounts; the statement-level totals sum each column.
 */
class CustomerAccountStatementService {
  static async getStatement(customerId, tenantId, query = {}) {
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");

    const filter = { tenantId, customerId };
    if (query.dateFrom || query.dateTo) {
      filter.issueDate = {};
      if (query.dateFrom) filter.issueDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.issueDate.$lte = new Date(query.dateTo);
    }
    if (query.status) filter.status = query.status;

    const receivables = await AccountsReceivableModel.find(filter).sort({ issueDate: 1 }).lean();
    const invoiceNumbers = receivables.map((r) => r.invoiceNumber);

    const bookings = invoiceNumbers.length > 0
      ? await BookingHeaderModel.find({ tenantId, customerId, "financialSnapshot.invoiceNumber": { $in: invoiceNumbers } })
          .select("bookingNumber bookingReference bookingType status financialSnapshot.invoiceNumber")
          .lean()
      : [];
    const bookingByInvoiceNumber = new Map(bookings.map((b) => [b.financialSnapshot.invoiceNumber, b]));

    // §1/§2 — receivables can be billed in different currencies; summing them
    // raw (or displaying them raw) would silently mix currencies into a
    // meaningless number. Resolve one "totals currency" and, when a caller
    // explicitly wants everything shown in one currency (viewCurrency),
    // reuse the exact same rate cache for the per-row amounts too — see
    // multi-currency-booking-and-statement-requirements.md §1/§2.
    const viewCurrency = query.viewCurrency ? query.viewCurrency.toUpperCase() : null;
    const distinctCurrencies = [...new Set(receivables.map((r) => r.currency).filter(Boolean))];
    const allSameCurrency = distinctCurrencies.length <= 1;
    const totalsCurrency = viewCurrency || (allSameCurrency ? (receivables[0]?.currency || null) : await CurrencyService.getBaseCurrency(tenantId));

    const rateCache = new Map(); // fromCurrency -> rate into totalsCurrency
    if (totalsCurrency) {
      const uniqueFromCurrencies = distinctCurrencies.filter((c) => c && c !== totalsCurrency);
      for (const from of uniqueFromCurrencies) {
        const { rate } = await CurrencyService.getRate(tenantId, from, totalsCurrency);
        rateCache.set(from, rate);
      }
    }
    const toTotalsCurrency = (amount, fromCurrency) =>
      !totalsCurrency || fromCurrency === totalsCurrency ? amount : roundCurrency(amount * (rateCache.get(fromCurrency) || 1));

    const rows = receivables.map((receivable, index) => {
      const booking = bookingByInvoiceNumber.get(receivable.invoiceNumber) || null;
      const originalCurrency = receivable.currency;
      const displayCurrency = viewCurrency || originalCurrency;
      const convert = (amount) => toTotalsCurrency(amount, originalCurrency);
      return {
        rowNumber: index + 1,
        referenceNumber: booking?.bookingNumber || receivable.invoiceNumber,
        bookingId: booking?._id || null,
        bookingType: booking?.bookingType || null,
        bookingStatus: booking?.status || null,
        date: receivable.issueDate,
        dueDate: receivable.dueDate,
        description: booking ? `Booking ${booking.bookingNumber}` : `Invoice ${receivable.invoiceNumber}`,
        invoiceNumber: receivable.invoiceNumber,
        currency: displayCurrency,
        originalCurrency,
        debit: viewCurrency ? convert(receivable.originalAmount) : receivable.originalAmount,
        credit: viewCurrency ? convert(receivable.paidAmount) : receivable.paidAmount,
        balance: viewCurrency ? convert(receivable.outstandingBalance) : receivable.outstandingBalance,
        status: receivable.status
      };
    });

    const totals = {
      totalDebit: roundCurrency(receivables.reduce((sum, r) => sum + toTotalsCurrency(r.originalAmount, r.currency), 0)),
      totalCredit: roundCurrency(receivables.reduce((sum, r) => sum + toTotalsCurrency(r.paidAmount, r.currency), 0)),
      totalBalance: roundCurrency(receivables.reduce((sum, r) => sum + toTotalsCurrency(r.outstandingBalance, r.currency), 0)),
      currency: totalsCurrency
    };

    return {
      customer: {
        customerId: customer._id,
        customerCode: customer.customerCode,
        name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer"
      },
      period: { dateFrom: query.dateFrom || null, dateTo: query.dateTo || null },
      viewCurrency: viewCurrency || null,
      totals,
      rows,
      generatedAt: new Date()
    };
  }
}

export default CustomerAccountStatementService;
