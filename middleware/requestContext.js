import { createRequestId } from "../utils/authTokens.js";
import { runWithCorrelationId } from "../utils/correlationContext.js";

// Enterprise Correlation & Traceability Standard (Enterprise Architecture
// Hardening Phase, Improvement 5). Real UUID v4 (`createRequestId` ->
// `crypto.randomUUID()`). `X-Request-ID` stays the primary header this
// codebase has always used (every existing test/doc/log line already
// reads `req.requestId`, unchanged); `Correlation-ID` is the spec's own
// enterprise-standard alias — accepted from the client with the same
// precedence, and echoed back on the response alongside `X-Request-ID`,
// never a second, different id.
const requestContext = (req, res, next) => {
    const headerRequestId = req.header("Correlation-ID") || req.header("X-Request-ID");
    req.requestId = headerRequestId || createRequestId();
    req.correlationId = req.requestId;
    res.setHeader("X-Request-ID", req.requestId);
    res.setHeader("Correlation-ID", req.requestId);
    // Everything downstream of this middleware — every controller,
    // service, `publishEvent` call, and `logger.*` call for the lifetime
    // of this request — runs inside this async context, so
    // `getCorrelationId()` resolves to this exact id anywhere in that
    // chain without a single parameter threaded through any of it.
    runWithCorrelationId(req.requestId, next);
};

export default requestContext;
