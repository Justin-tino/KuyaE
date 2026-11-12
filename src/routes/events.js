'use strict';

const express = require('express');
const { addSseClient } = require('../realtime');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/events - Server-Sent Events stream for live updates.
 * Every signed-in browser tab keeps one of these open.
 */
router.get('/', requireAuth, (req, res) => {
  addSseClient(req, res, req.user);
});

module.exports = router;
