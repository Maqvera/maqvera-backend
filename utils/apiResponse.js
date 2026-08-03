export const sendSuccess = (res, statusCode, message, data, requestId) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        requestId
    });
};

export const sendError = (res, statusCode, message, requestId, data = null) => {
    return res.status(statusCode).json({
        success: false,
        message,
        data,
        requestId
    });
};