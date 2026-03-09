import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { config } from "./config/index.js";
import authRoutes from "./routes/auth.js";
import moodRouter from "./routes/mood.js";
import contentRouter from "./routes/content.js";
import audioRouter from "./routes/audio.js";
import feedbackRouter from "./routes/feedback.js";

const app = express();

// ---------------------------------------------------------------------------
// Trust proxy (required for App Runner / load balancer)
// ---------------------------------------------------------------------------
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(helmet());
app.use(cors({
  origin: config.CORS_ORIGIN.split(",").map((o) => o.trim()),
  credentials: true,
}));
app.use(morgan(config.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "16kb" }));

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use("/api", globalLimiter);

const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/mood", llmLimiter, moodRouter);
app.use("/api/content", contentRouter);
app.use("/api/audio", audioRouter);
app.use("/api/feedback", feedbackRouter);

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(`[ERROR] ${err.message}`, err.stack);
    res.status(500).json({
      error: config.NODE_ENV === "production" ? "Internal server error" : err.message,
    });
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(config.PORT, () => {
  console.log(`[seedlight] Server running on port ${config.PORT} (${config.NODE_ENV})`);
});

export default app;
