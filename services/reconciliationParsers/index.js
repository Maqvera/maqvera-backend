import CsvStatementParser from "./CsvStatementParser.js";
import ExcelStatementParser from "./ExcelStatementParser.js";
import Mt940StatementParser from "./Mt940StatementParser.js";
import Camt053StatementParser from "./Camt053StatementParser.js";
import OfxStatementParser from "./OfxStatementParser.js";
import CustomJsonStatementParser from "./CustomJsonStatementParser.js";

// Mirrors services/gateways/index.js's exact pattern — every configured
// format value that has a real parser below; "Open Banking API" is
// deliberately absent (see utils/financeConfig.js reconciliationImportFormats
// doc comment) since no live aggregator integration exists in this codebase.
const PARSERS = {
  CSV: new CsvStatementParser(),
  Excel: new ExcelStatementParser(),
  MT940: new Mt940StatementParser(),
  "CAMT.053": new Camt053StatementParser(),
  OFX: new OfxStatementParser(),
  Custom: new CustomJsonStatementParser()
};

/** Returns the parser for `format`, or null if not supported. */
export const getStatementParser = (format) => PARSERS[format] || null;

export default getStatementParser;
