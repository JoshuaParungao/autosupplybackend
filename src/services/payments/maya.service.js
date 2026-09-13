/**
 * Maya (PayMaya) Terminal & Checkout Integration Helper
 */

/**
 * Validates Maya Terminal Reference / Approval Trace Code
 * Maya POS hardware terminal slips always include a 6-digit approval code (AUTH / APPR CODE).
 */
function validateTerminalSlip({ approvalCode, traceNumber, terminalId, amount }) {
  if (!approvalCode || String(approvalCode).trim().length < 4) {
    return {
      valid: false,
      message: "Valid Maya terminal approval/authorization code is required (min 4-6 digits)",
    };
  }

  return {
    valid: true,
    terminalProvider: "MAYA_TERMINAL",
    approvalCode: String(approvalCode).trim().toUpperCase(),
    traceNumber: traceNumber ? String(traceNumber).trim() : null,
    terminalId: terminalId ? String(terminalId).trim() : "MAYA_ONE_DEFAULT",
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Prepares Maya Checkout Session (Maya Enterprise API ready)
 */
async function createMayaCheckoutSession({ amount, referenceNumber, customer }) {
  const apiKey = process.env.MAYA_API_KEY;
  if (!apiKey) {
    throw new Error("MAYA_API_KEY is not configured in environment");
  }

  // Pre-formatted Maya V1 Checkout Payload
  return {
    provider: "MAYA",
    totalAmount: {
      value: Number(amount),
      currency: "PHP",
    },
    requestReferenceNumber: referenceNumber,
    buyer: {
      firstName: customer?.fullName?.split(" ")?.[0] || "Valued",
      lastName: customer?.fullName?.split(" ")?.slice(1)?.join(" ") || "Customer",
      contact: {
        phone: customer?.mobileNumber || "",
        email: customer?.email || "",
      },
    },
    status: "READY_FOR_DISPATCH",
  };
}

module.exports = {
  validateTerminalSlip,
  createMayaCheckoutSession,
};
