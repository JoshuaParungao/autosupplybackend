const paymongoService = require("../services/payments/paymongo.service");
const mayaService = require("../services/payments/maya.service");
const { sendSuccess, sendError } = require("../utils/apiResponse");

/**
 * Generate PayMongo Dynamic QR Ph for Cashier POS
 */
async function generatePayMongoQr(req, res, next) {
  try {
    const { amount, description, referenceNumber } = req.body;

    if (!amount || Number(amount) <= 0) {
      return sendError(res, "Valid amount is required to generate QR code", 400);
    }

    const intent = await paymongoService.createQrPhPayment({
      amount,
      description: description || "Pointify POS Payment",
      referenceNumber: referenceNumber || `REF-${Date.now()}`,
    });

    return sendSuccess(res, {
      message: "PayMongo QR Ph payment intent created",
      data: intent,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Generate PayMongo Shareable Payment Link
 */
async function generatePaymentLink(req, res, next) {
  try {
    const { amount, description, remarks } = req.body;

    if (!amount || Number(amount) <= 0) {
      return sendError(res, "Valid amount is required", 400);
    }

    const link = await paymongoService.createPaymentLink({
      amount,
      description,
      remarks,
    });

    return sendSuccess(res, {
      message: "PayMongo payment link generated",
      data: link,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Validate Maya Terminal Slip
 */
function validateMayaTerminal(req, res) {
  const { approvalCode, traceNumber, terminalId, amount } = req.body;

  const result = mayaService.validateTerminalSlip({
    approvalCode,
    traceNumber,
    terminalId,
    amount,
  });

  if (!result.valid) {
    return sendError(res, result.message, 400);
  }

  return sendSuccess(res, {
    message: "Maya terminal approval code verified",
    data: result,
  });
}

/**
 * Handle Incoming PayMongo Webhooks
 */
async function handlePayMongoWebhook(req, res) {
  const signature = req.headers["paymongo-signature"];
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

  // If webhook secret is set, verify cryptographic signature
  if (webhookSecret && signature) {
    const rawBody = JSON.stringify(req.body);
    const isValid = paymongoService.verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      return res.status(400).json({ error: "Invalid webhook signature" });
    }
  }

  const event = req.body?.data?.attributes;
  const eventType = event?.type;

  // Log incoming payment events
  console.log(`[PayMongo Webhook] Received event: ${eventType}`);

  // Acknowledge receipt to PayMongo immediately
  return res.status(200).json({ received: true });
}

module.exports = {
  generatePayMongoQr,
  generatePaymentLink,
  validateMayaTerminal,
  handlePayMongoWebhook,
};
