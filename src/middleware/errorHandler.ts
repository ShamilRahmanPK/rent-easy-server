import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

export function notFoundHandler(_request: Request, response: Response) {
  response.status(404).json({ error: "Route not found" });
}

export function errorHandler(error: unknown, request: Request, response: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return response.status(error.status).json({ error: error.message, details: error.details });
  }

  if (error instanceof ZodError) {
    return response.status(400).json({
      error: "Invalid input",
      details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    });
  }

  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "File is too large"
        : error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE"
          ? "Too many files, or wrong field name"
          : error.message;
    return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: message });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return response.status(409).json({ error: "A record with these details already exists" });
    if (error.code === "P2025") return response.status(404).json({ error: "Record not found" });
    if (error.code === "P2003") return response.status(409).json({ error: "This record is linked to other records" });
  }

  if (error instanceof SyntaxError && "body" in error) {
    return response.status(400).json({ error: "Malformed JSON body" });
  }

  console.error(`[${request.method} ${request.originalUrl}]`, error);
  response.status(500).json({
    error: env.isProduction ? "Server error" : error instanceof Error ? error.message : "Server error",
  });
}
