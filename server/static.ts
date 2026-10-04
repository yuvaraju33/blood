import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(process.cwd(), "dist", "public");
  if (!fs.existsSync(distPath)) {
    console.warn(
      `[static] Could not find the build directory: ${distPath}, static files won't be served`,
    );
    // Return a simple fallback instead of crashing
    app.use("*", (_req, res) => {
      res.status(503).json({ message: "Application is starting up, please try again shortly." });
    });
    return;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
