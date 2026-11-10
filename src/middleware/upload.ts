import multer from "multer";
import { badRequest } from "../lib/errors.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

const MB = 1024 * 1024;

// Files are held in memory, verified by content (not by the name the client sent), then written by the files service.
const storage = multer.memoryStorage();

export const imageUpload = (maxFiles: number, maxSizeMb = 5) =>
  multer({
    storage,
    limits: { fileSize: maxSizeMb * MB, files: maxFiles },
    fileFilter: (_request, file, callback) =>
      IMAGE_TYPES.has(file.mimetype) ? callback(null, true) : callback(badRequest("Only JPG, PNG or WebP images are allowed")),
  });

export const documentUpload = (maxFiles: number, maxSizeMb = 10) =>
  multer({
    storage,
    limits: { fileSize: maxSizeMb * MB, files: maxFiles },
    fileFilter: (_request, file, callback) =>
      DOCUMENT_TYPES.has(file.mimetype) ? callback(null, true) : callback(badRequest("Only PDF, JPG or PNG files are allowed")),
  });
