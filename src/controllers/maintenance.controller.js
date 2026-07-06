'use strict';

const maintenanceService = require('../services/maintenance.service');
const AppError = require('../errors/app-error');

/**
 * POST /api/maintenance/generate-line-items
 * Valida el body y delega la orquestación al service.
 */
async function generateLineItems(req, res, next) {
  try {
    const { dealId } = req.body || {};

    if (dealId === undefined || dealId === null || String(dealId).trim() === '') {
      throw AppError.badRequest('El campo "dealId" es obligatorio.', 'MISSING_DEAL_ID');
    }

    const summary = await maintenanceService.generateLineItems(String(dealId).trim());
    return res.status(200).json(summary);
  } catch (error) {
    return next(error);
  }
}

module.exports = { generateLineItems };
