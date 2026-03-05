import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { config } from "./config/index.js";
import authRoutes from "./routes/auth.js";
import moodRouter from "./routes/mood.js";
import contentRouter from "./routes/content.js";
import audioRouter from "./routes/audio.js";
import feedbackRouter from "./routes/feedback.js";

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(helmet());
app.use(cors());
app.use(morgan(config.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Route stubs
// ---------------------------------------------------------------------------
app.use("/api/auth", authRoutes);

app.use("/api/mood", moodRouter);
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
