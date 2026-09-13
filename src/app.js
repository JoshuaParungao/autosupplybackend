const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const env = require("./config/env");
const AppError = require("./utils/appError");
const { sendSuccess } = require("./utils/apiResponse");
const apiRoutes = require("./routes/api.routes");
const notFound = require("./middlewares/notFound.middleware");
const globalErrorHandler = require("./middlewares/errorHandler.middleware");

const app = express();

app.set("trust proxy", env.trustProxy);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = origin.replace(/\/$/, "");
    if (
      env.corsOrigins.includes("*") ||
      env.corsOrigins.includes(normalized) ||
      normalized.includes("vercel.app") ||
      (normalized.includes("sslip.io") && env.corsOrigins.some((o) => o.includes("sslip.io"))) ||
      normalized.includes("autosupply") ||
      normalized.includes("arunafeltzcomputerpos.cloud")
    ) {
      return callback(null, true);
    }
    return callback(new AppError("Request origin is not allowed", 403, "CORS_ORIGIN_DENIED"));
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

app.get("/", (req, res) => {
  return sendSuccess(res, {
    message: "Arunafeltz Backend API is running",
    data: {
      service: "arunafeltz-backend",
      status: "online",
    },
  });
});

app.use("/api", apiRoutes);

app.use(notFound);
app.use(globalErrorHandler);

module.exports = app;
