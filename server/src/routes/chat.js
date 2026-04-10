const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat');

// Maps POST requests to /api/v1/campus/chat to the chat controller
router.post('/chat', chatController.handleChat);

module.exports = router;