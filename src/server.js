'use strict';

const logger = require('./utils/logger');

let app;
let env;
try {
  // env.js valida las variables obligatorias y puede lanzar si faltan.
  env = require('./config/env');
  app = require('./app');
} catch (error) {
  logger.error('No se pudo iniciar la aplicación:', error.message);
  process.exit(1);
}

const server = app.listen(env.port, () => {
  logger.info(`Servidor escuchando en el puerto ${env.port}.`);
});

// Apagado ordenado.
function shutdown(signal) {
  logger.info(`Recibida señal ${signal}. Cerrando servidor...`);
  server.close(() => {
    logger.info('Servidor cerrado.');
    process.exit(0);
  });
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});
