'use strict';

const axios = require('axios');
const env = require('../config/env');
const AppError = require('../errors/app-error');
const logger = require('../utils/logger');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

let tokenCache = { value: null, expiresAt: 0 };

/**
 * Base del recurso del workbook según cómo se identifique el archivo:
 * driveId + itemId (recomendado) o userId + itemId.
 */
function workbookBase() {
  const { driveId, userId, itemId } = env.onedrive;
  const item = encodeURIComponent(itemId);
  if (driveId) {
    return `/drives/${encodeURIComponent(driveId)}/items/${item}/workbook`;
  }
  return `/users/${encodeURIComponent(userId)}/drive/items/${item}/workbook`;
}

function toUpstreamError(error, action) {
  const status = error.response?.status;
  const body = error.response?.data;
  logger.error(`Microsoft Graph error en ${action}:`, status, JSON.stringify(body || error.message));
  return AppError.upstream(`Error consultando OneDrive/Graph (${action}).`, 'ONEDRIVE_ERROR', {
    status,
    body,
  });
}

/**
 * Obtiene (y cachea) un token de aplicación vía client credentials.
 */
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const { tenantId, clientId, clientSecret } = env.onedrive;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  try {
    const resp = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    const { access_token: accessToken, expires_in: expiresIn } = resp.data;
    // Renovar 60s antes de expirar.
    tokenCache = { value: accessToken, expiresAt: now + (expiresIn - 60) * 1000 };
    return accessToken;
  } catch (error) {
    throw toUpstreamError(error, 'getAccessToken');
  }
}

async function graphGet(pathSuffix, action) {
  const token = await getAccessToken();
  try {
    const resp = await axios.get(`${GRAPH_BASE_URL}${pathSuffix}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    });
    return resp.data;
  } catch (error) {
    throw toUpstreamError(error, action);
  }
}

/**
 * Devuelve los nombres de todas las hojas del workbook.
 */
async function getSheetNames() {
  const data = await graphGet(`${workbookBase()}/worksheets?$select=name`, 'getSheetNames');
  return (data.value || []).map((ws) => ws.name);
}

/**
 * Devuelve la matriz de valores (filas x columnas) de una hoja.
 * usedRange(valuesOnly=true) ya entrega una matriz 2D en `values`.
 */
async function getSheetValues(sheetName) {
  const data = await graphGet(
    `${workbookBase()}/worksheets/${encodeURIComponent(sheetName)}/usedRange(valuesOnly=true)?$select=values`,
    `getSheetValues(${sheetName})`
  );
  return data.values || [];
}

module.exports = { getSheetNames, getSheetValues };
