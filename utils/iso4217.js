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
export const ISO_4217_CURRENCIES = {
  USD: { name: "US Dollar", decimalPlaces: 2 },
  EUR: { name: "Euro", decimalPlaces: 2 },
  GBP: { name: "British Pound", decimalPlaces: 2 },
  PKR: { name: "Pakistani Rupee", decimalPlaces: 2 },
  AED: { name: "UAE Dirham", decimalPlaces: 2 },
  SAR: { name: "Saudi Riyal", decimalPlaces: 2 },
  QAR: { name: "Qatari Riyal", decimalPlaces: 2 },
  KWD: { name: "Kuwaiti Dinar", decimalPlaces: 3 },
  BHD: { name: "Bahraini Dinar", decimalPlaces: 3 },
  OMR: { name: "Omani Rial", decimalPlaces: 3 },
  INR: { name: "Indian Rupee", decimalPlaces: 2 },
  CNY: { name: "Chinese Yuan", decimalPlaces: 2 },
  JPY: { name: "Japanese Yen", decimalPlaces: 0 },
  CHF: { name: "Swiss Franc", decimalPlaces: 2 },
  CAD: { name: "Canadian Dollar", decimalPlaces: 2 },
  AUD: { name: "Australian Dollar", decimalPlaces: 2 },
  SGD: { name: "Singapore Dollar", decimalPlaces: 2 },
  HKD: { name: "Hong Kong Dollar", decimalPlaces: 2 },
  TRY: { name: "Turkish Lira", decimalPlaces: 2 },
  ZAR: { name: "South African Rand", decimalPlaces: 2 },
  EGP: { name: "Egyptian Pound", decimalPlaces: 2 },
  BDT: { name: "Bangladeshi Taka", decimalPlaces: 2 },
  LKR: { name: "Sri Lankan Rupee", decimalPlaces: 2 },
  NPR: { name: "Nepalese Rupee", decimalPlaces: 2 },
  AFN: { name: "Afghan Afghani", decimalPlaces: 2 },
  MYR: { name: "Malaysian Ringgit", decimalPlaces: 2 },
  IDR: { name: "Indonesian Rupiah", decimalPlaces: 2 },
  THB: { name: "Thai Baht", decimalPlaces: 2 },
  PHP: { name: "Philippine Peso", decimalPlaces: 2 },
  VND: { name: "Vietnamese Dong", decimalPlaces: 0 },
  KRW: { name: "South Korean Won", decimalPlaces: 0 },
  NZD: { name: "New Zealand Dollar", decimalPlaces: 2 },
  SEK: { name: "Swedish Krona", decimalPlaces: 2 },
  NOK: { name: "Norwegian Krone", decimalPlaces: 2 },
  DKK: { name: "Danish Krone", decimalPlaces: 2 },
  RUB: { name: "Russian Ruble", decimalPlaces: 2 },
  JOD: { name: "Jordanian Dinar", decimalPlaces: 3 },
  LBP: { name: "Lebanese Pound", decimalPlaces: 2 },
  IQD: { name: "Iraqi Dinar", decimalPlaces: 3 },
  IRR: { name: "Iranian Rial", decimalPlaces: 2 },
  ILS: { name: "Israeli New Shekel", decimalPlaces: 2 },
  BRL: { name: "Brazilian Real", decimalPlaces: 2 },
  MXN: { name: "Mexican Peso", decimalPlaces: 2 },
  NGN: { name: "Nigerian Naira", decimalPlaces: 2 },
  KES: { name: "Kenyan Shilling", decimalPlaces: 2 }
};

/** Real ISO 4217 alphabetic-code format check — 3 uppercase letters, and present in the curated reference table above. */
export const isValidIso4217Code = (code) => typeof code === "string" && /^[A-Z]{3}$/.test(code) && Object.prototype.hasOwnProperty.call(ISO_4217_CURRENCIES, code);

export default ISO_4217_CURRENCIES;
