import { createRequestId } from "../utils/authTokens.js";

const requestContext = (req, res, next) => {
    const headerRequestId = req.header("X-Request-ID");
    req.requestId = headerRequestId || createRequestId();
    res.setHeader("X-Request-ID", req.requestId);
    next();
};

export default requestContext;