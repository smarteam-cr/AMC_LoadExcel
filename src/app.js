'use strict';

const express = require('express');
const maintenanceRoutes = require('./routes/maintenance.routes');
const logger = require('./utils/logger');
const AppError = require('./errors/app-error');

const app = express();

app.use(express.json());

// Log básico de cada request.
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`);
  next();
});

// Healthcheck.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Rutas de la API.
app.use('/api/maintenance', maintenanceRoutes);

// 404 para rutas no encontradas.
app.use((req, res) => {
  res.status(404).json({ success: false, code: 'ROUTE_NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

// Middleware central de manejo de errores.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details || undefined,
    });
  }

  // Error de JSON malformado de express.json().
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, code: 'INVALID_JSON', message: 'El body no es un JSON válido.' });
  }

  logger.error('Error no controlado:', err.stack || err.message);
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Ocurrió un error interno inesperado.',
  });
});

module.exports = app;
