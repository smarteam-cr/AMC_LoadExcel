'use strict';

const { google } = require('googleapis');
const env = require('../config/env');
const AppError = require('../errors/app-error');
const logger = require('../utils/logger');

let sheetsClient = null;

/**
 * Crea (una sola vez) el cliente autenticado de Google Sheets.
 */
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.JWT({
    email: env.google.clientEmail,
    key: env.google.privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function toUpstreamError(error, action) {
  const message = error.errors?.[0]?.message || error.message;
  logger.error(`Google Sheets error en ${action}:`, message);
  return AppError.upstream(`Error consultando Google Sheets (${action}).`, 'GOOGLE_SHEETS_ERROR', {
    message,
  });
}

/**
 * Devuelve los nombres de todas las hojas del spreadsheet.
 */
async function getSheetNames() {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.get({ spreadsheetId: env.google.sheetId });
    return (resp.data.sheets || []).map((s) => s.properties.title);
  } catch (error) {
    throw toUpstreamError(error, 'getSheetNames');
  }
}

/**
 * Devuelve la matriz de valores (filas x columnas) de una hoja.
 */
async function getSheetValues(sheetName) {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: env.google.sheetId,
      range: sheetName,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return resp.data.values || [];
  } catch (error) {
    throw toUpstreamError(error, `getSheetValues(${sheetName})`);
  }
}

module.exports = { getSheetNames, getSheetValues };
