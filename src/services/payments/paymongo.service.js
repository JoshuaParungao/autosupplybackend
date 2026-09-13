const https = require("https");
const crypto = require("crypto");

/**
 * PayMongo API Client Helper
 */
function callPayMongoApi(endpoint, method = "GET", data = null) {
  return new Promise((resolve, reject) => {
    const secretKey = process.env.PAYMONGO_SECRET_KEY;
    if (!secretKey) {
      return reject(new Error("PAYMONGO_SECRET_KEY is not configured in environment"));
    }

    const authHeader = `Basic ${Buffer.from(secretKey + ":").toString("base64")}`;
    const payloadString = data ? JSON.stringify({ data }) : null;

    const options = {
      hostname: "api.paymongo.com",
      path: `/v1${endpoint}`,
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    if (payloadString) {
      options.headers["Content-Length"] = Buffer.byteLength(payloadString);
    }

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed.data || parsed);
          } else {
            const errorMsg =
              parsed.errors?.[0]?.detail ||
              parsed.errors?.[0]?.code ||
              `PayMongo error (status ${res.statusCode})`;
            reject(new Error(errorMsg));
          }
        } catch (e) {
          reject(new Error("Failed to parse PayMongo response"));
        }
      });
    });

    req.on("error", (err) => reject(err));
    if (payloadString) req.write(payloadString);
    req.end();
  });
}

/**
 * Creates a Dynamic QR Ph code for POS checkout
 * Allows customers to scan using GCash, Maya, ShopeePay, BDO, BPI, UnionBank, etc.
 * Amount is in centavos (PHP 100.00 = 10000 centavos)
 */
async function createQrPhPayment({ amount, description = "Pointify POS Payment", referenceNumber = "" }) {
  const amountInCentavos = Math.round(Number(amount) * 100);

  const attributes = {
    amount: amountInCentavos,
    payment_method_allowed: ["qrph", "gcash", "paymaya", "card", "dob"],
    payment_method_options: {
      card: { request_three_d_secure: "any" },
    },
    currency: "PHP",
    description: `${description} [${referenceNumber}]`.trim(),
    statement_descriptor: "POINTIFY POS",
  };

  return callPayMongoApi("/payment_intents", "POST", { attributes });
}

/**
 * Creates a PayMongo Shareable Payment Link (convenient for quotes / receivables)
 */
async function createPaymentLink({ amount, description = "Pointify Order", remarks = "" }) {
  const amountInCentavos = Math.round(Number(amount) * 100);

  const attributes = {
    amount: amountInCentavos,
    description,
    remarks,
  };

  return callPayMongoApi("/links", "POST", { attributes });
}

/**
 * Verifies PayMongo Webhook HMAC SHA-256 signature
 */
function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader || !webhookSecret) return false;

  try {
    // Header format: t=timestamp,te=test_sig,li=live_sig
    const parts = signatureHeader.split(",");
    const timestampPart = parts.find((p) => p.startsWith("t="));
    const liveSigPart = parts.find((p) => p.startsWith("li=")) || parts.find((p) => p.startsWith("te="));

    if (!timestampPart || !liveSigPart) return false;

    const timestamp = timestampPart.slice(2);
    const signature = liveSigPart.slice(3);

    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(signedPayload)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSignature, "hex")
    );
  } catch (err) {
    return false;
  }
}

module.exports = {
  createQrPhPayment,
  createPaymentLink,
  verifyWebhookSignature,
};
