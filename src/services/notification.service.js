const https = require("https");
const http = require("http");
const env = require("../config/env");

/**
 * Helper to dispatch an HTTP POST request safely without blocking
 */
function sendJsonPost(targetUrl, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === "https:";
      const transport = isHttps ? https : http;
      const dataString = JSON.stringify(payload);

      const req = transport.request(
        targetUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(dataString),
            ...headers,
          },
          timeout: 8000,
        },
        (res) => {
          let responseBody = "";
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => {
            resolve({ statusCode: res.statusCode, body: responseBody });
          });
        }
      );

      req.on("error", (err) => {
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy(new Error("Request timed out"));
      });

      req.write(dataString);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Format Philippine Peso currency
 */
function formatPhp(amount) {
  const num = Number(amount || 0);
  return `₱${num.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Dispatches notification to Telegram Bot if configured
 */
async function sendTelegramAlert(saleData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  const branchName = saleData.branch?.name || saleData.branch?.code || "Branch";
  const cashierName =
    saleData.cashier?.fullName || saleData.cashier?.username || "Cashier";
  const receiptNo = saleData.receiptCode || `#${saleData.id?.slice(-6)}`;
  const totalAmount = formatPhp(saleData.totalAmount);
  const itemsCount = saleData.items?.length || saleData._count?.items || 1;

  const paymentMethods =
    saleData.payments && saleData.payments.length > 0
      ? saleData.payments
          .map((p) => `${p.paymentMethod}${p.referenceNo ? ` (${p.referenceNo})` : ""}`)
          .join(", ")
      : "Cash";

  const message = [
    `🔔 *POINTIFY PAYMENT RECEIVED* 💰`,
    ``,
    `🏪 *Branch:* ${branchName}`,
    `🧾 *Receipt:* \`${receiptNo}\``,
    `💵 *Amount:* *${totalAmount}*`,
    `💳 *Method:* ${paymentMethods}`,
    `📦 *Items Sold:* ${itemsCount}`,
    `👤 *Cashier:* ${cashierName}`,
    `🕒 *Time:* ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`,
  ].join("\n");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await sendJsonPost(url, {
    chat_id: chatId,
    text: message,
    parse_mode: "Markdown",
  });
}

/**
 * Dispatches notification to Expo Push Notifications (iOS & Android Mobile App)
 */
async function sendExpoPushNotification(saleData) {
  const pushToken = process.env.EXPO_PUSH_TOKEN;
  if (!pushToken) return;

  const branchName = saleData.branch?.name || "Branch";
  const receiptNo = saleData.receiptCode || "Sale";
  const totalAmount = formatPhp(saleData.totalAmount);

  const payload = {
    to: pushToken,
    sound: "default",
    title: `💰 Payment Received: ${totalAmount}`,
    body: `${branchName} - ${receiptNo} paid via ${saleData.payments?.[0]?.paymentMethod || "Cash"}`,
    data: {
      type: "PAYMENT_RECEIVED",
      saleId: saleData.id,
      receiptCode: saleData.receiptCode,
      amount: saleData.totalAmount,
      branchId: saleData.branchId,
    },
    priority: "high",
  };

  await sendJsonPost("https://exp.host/--/api/v2/push/send", payload);
}

/**
 * Dispatches notification to Custom Webhook URL (Mobile app backend / Zapier / Make)
 */
async function sendCustomWebhook(saleData) {
  const webhookUrl = process.env.OWNER_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = {
    event: "PAYMENT_RECEIVED",
    timestamp: new Date().toISOString(),
    sale: {
      id: saleData.id,
      receiptCode: saleData.receiptCode,
      totalAmount: saleData.totalAmount,
      discountAmount: saleData.discountAmount,
      branch: saleData.branch,
      cashier: saleData.cashier,
      customer: saleData.customer,
      payments: saleData.payments,
      itemsCount: saleData.items?.length || saleData._count?.items || 0,
    },
  };

  await sendJsonPost(webhookUrl, payload, {
    "X-Pointify-Event": "PAYMENT_RECEIVED",
  });
}

/**
 * Main Central Dispatcher for Pointify
 * Executed non-blocking via setImmediate so POS speed is never affected.
 */
function dispatchPaymentReceived(saleData) {
  setImmediate(async () => {
    try {
      await Promise.allSettled([
        sendTelegramAlert(saleData),
        sendExpoPushNotification(saleData),
        sendCustomWebhook(saleData),
      ]);
    } catch (err) {
      console.error("[NotificationService] Dispatch error:", err.message);
    }
  });
}

module.exports = {
  dispatchPaymentReceived,
  sendTelegramAlert,
  sendExpoPushNotification,
  sendCustomWebhook,
};
