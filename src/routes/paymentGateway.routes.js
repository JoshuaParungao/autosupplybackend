const express = require("express");
const paymentController = require("../controllers/paymentGateway.controller");
const { protect } = require("../middlewares/auth.middleware");

const router = express.Router();

// POS Cashier endpoints (Protected)
router.post("/paymongo/qr", protect, paymentController.generatePayMongoQr);
router.post("/paymongo/link", protect, paymentController.generatePaymentLink);
router.post("/maya/verify-terminal", protect, paymentController.validateMayaTerminal);

// Public Webhook listener for PayMongo
router.post("/webhooks/paymongo", paymentController.handlePayMongoWebhook);

module.exports = router;
