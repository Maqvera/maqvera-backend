// Real ISO 4217 alphabetic currency code reference table — Finance Module
// Part 19 (Multi-Currency & Foreign Exchange). "Valid ISO 4217 Code" is a
// named validation rule for currency creation; this is the real standard's
// own stable, largely-unchanging reference data (code -> name/decimal
// places), the same category of static reference table as this codebase's
// own `DEFAULT_PERMISSIONS`/`accountCategories` — not mock/sample data.
// Covers the world's major and regionally-relevant trading currencies
// (including every currency this codebase's own env defaults/examples
// already mention — PKR, USD, EUR, GBP, AED, SAR) rather than the full
// ~180-entry ISO list, which would be unmaintainable dead weight here.
// Each entry's own real `decimalPlaces` (0 for JPY/VND/KRW, 3 for the
// Gulf/Jordan dinar currencies, 2 otherwise) is used to auto-fill
// CurrencyModel.decimalPlaces at creation unless the caller overrides it.
// `numericCode` (File 4 Part 2 — "ISO Numeric Code") is the real ISO 4217
// 3-digit numeric code for each entry — used to auto-fill/cross-validate
// `CurrencyModel.isoNumericCode` at creation, the same "real standard
// reference data, filled in automatically unless overridden" treatment
// `decimalPlaces` already gets.
export const ISO_4217_CURRENCIES = {
  USD: { name: "US Dollar", decimalPlaces: 2, numericCode: "840" },
  EUR: { name: "Euro", decimalPlaces: 2, numericCode: "978" },
  GBP: { name: "British Pound", decimalPlaces: 2, numericCode: "826" },
  PKR: { name: "Pakistani Rupee", decimalPlaces: 2, numericCode: "586" },
  AED: { name: "UAE Dirham", decimalPlaces: 2, numericCode: "784" },
  SAR: { name: "Saudi Riyal", decimalPlaces: 2, numericCode: "682" },
  QAR: { name: "Qatari Riyal", decimalPlaces: 2, numericCode: "634" },
  KWD: { name: "Kuwaiti Dinar", decimalPlaces: 3, numericCode: "414" },
  BHD: { name: "Bahraini Dinar", decimalPlaces: 3, numericCode: "048" },
  OMR: { name: "Omani Rial", decimalPlaces: 3, numericCode: "512" },
  INR: { name: "Indian Rupee", decimalPlaces: 2, numericCode: "356" },
  CNY: { name: "Chinese Yuan", decimalPlaces: 2, numericCode: "156" },
  JPY: { name: "Japanese Yen", decimalPlaces: 0, numericCode: "392" },
  CHF: { name: "Swiss Franc", decimalPlaces: 2, numericCode: "756" },
  CAD: { name: "Canadian Dollar", decimalPlaces: 2, numericCode: "124" },
  AUD: { name: "Australian Dollar", decimalPlaces: 2, numericCode: "036" },
  SGD: { name: "Singapore Dollar", decimalPlaces: 2, numericCode: "702" },
  HKD: { name: "Hong Kong Dollar", decimalPlaces: 2, numericCode: "344" },
  TRY: { name: "Turkish Lira", decimalPlaces: 2, numericCode: "949" },
  ZAR: { name: "South African Rand", decimalPlaces: 2, numericCode: "710" },
  EGP: { name: "Egyptian Pound", decimalPlaces: 2, numericCode: "818" },
  BDT: { name: "Bangladeshi Taka", decimalPlaces: 2, numericCode: "050" },
  LKR: { name: "Sri Lankan Rupee", decimalPlaces: 2, numericCode: "144" },
  NPR: { name: "Nepalese Rupee", decimalPlaces: 2, numericCode: "524" },
  AFN: { name: "Afghan Afghani", decimalPlaces: 2, numericCode: "971" },
  MYR: { name: "Malaysian Ringgit", decimalPlaces: 2, numericCode: "458" },
  IDR: { name: "Indonesian Rupiah", decimalPlaces: 2, numericCode: "360" },
  THB: { name: "Thai Baht", decimalPlaces: 2, numericCode: "764" },
  PHP: { name: "Philippine Peso", decimalPlaces: 2, numericCode: "608" },
  VND: { name: "Vietnamese Dong", decimalPlaces: 0, numericCode: "704" },
  KRW: { name: "South Korean Won", decimalPlaces: 0, numericCode: "410" },
  NZD: { name: "New Zealand Dollar", decimalPlaces: 2, numericCode: "554" },
  SEK: { name: "Swedish Krona", decimalPlaces: 2, numericCode: "752" },
  NOK: { name: "Norwegian Krone", decimalPlaces: 2, numericCode: "578" },
  DKK: { name: "Danish Krone", decimalPlaces: 2, numericCode: "208" },
  RUB: { name: "Russian Ruble", decimalPlaces: 2, numericCode: "643" },
  JOD: { name: "Jordanian Dinar", decimalPlaces: 3, numericCode: "400" },
  LBP: { name: "Lebanese Pound", decimalPlaces: 2, numericCode: "422" },
  IQD: { name: "Iraqi Dinar", decimalPlaces: 3, numericCode: "368" },
  IRR: { name: "Iranian Rial", decimalPlaces: 2, numericCode: "364" },
  ILS: { name: "Israeli New Shekel", decimalPlaces: 2, numericCode: "376" },
  BRL: { name: "Brazilian Real", decimalPlaces: 2, numericCode: "986" },
  MXN: { name: "Mexican Peso", decimalPlaces: 2, numericCode: "484" },
  NGN: { name: "Nigerian Naira", decimalPlaces: 2, numericCode: "566" },
  KES: { name: "Kenyan Shilling", decimalPlaces: 2, numericCode: "404" }
};

/** Real ISO 4217 alphabetic-code format check — 3 uppercase letters, and present in the curated reference table above. */
export const isValidIso4217Code = (code) => typeof code === "string" && /^[A-Z]{3}$/.test(code) && Object.prototype.hasOwnProperty.call(ISO_4217_CURRENCIES, code);

/** Real ISO 4217 numeric-code format check — exactly 3 digits. Whether it matches a KNOWN alpha code's own real numeric code is validated separately (CurrencyService.createCurrency), since a caller may legitimately supply a numeric code for a currency outside this curated table. */
export const isValidIso4217NumericCode = (code) => typeof code === "string" && /^\d{3}$/.test(code);

export default ISO_4217_CURRENCIES;
