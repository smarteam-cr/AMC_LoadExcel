'use strict';

/**
 * Error de aplicación controlado. Lleva un statusCode HTTP y un code interno
 * para que el controlador pueda responder de forma consistente.
 */
class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, code = 'BAD_REQUEST', details = null) {
    return new AppError(message, { statusCode: 400, code, details });
  }

  static notFound(message, code = 'NOT_FOUND', details = null) {
    return new AppError(message, { statusCode: 404, code, details });
  }

  static unprocessable(message, code = 'UNPROCESSABLE', details = null) {
    return new AppError(message, { statusCode: 422, code, details });
  }

  static upstream(message, code = 'UPSTREAM_ERROR', details = null) {
    return new AppError(message, { statusCode: 502, code, details });
  }
}

module.exports = AppError;
