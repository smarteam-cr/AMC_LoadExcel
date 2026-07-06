'use strict';

const express = require('express');
const controller = require('../controllers/maintenance.controller');

const router = express.Router();

router.post('/generate-line-items', controller.generateLineItems);

module.exports = router;
