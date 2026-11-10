import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { FileAsset } from "@prisma/client";
import { env } from "../config/env.js";
import { badRequest } from "../lib/errors.js";

const PUBLIC_DIR = "public";
const PRIVATE_DIR = "private";

export interface StoredImage {
  storagePath: string;
  thumbPath: string;
  sizeBytes: number;
}

export interface StoredFile {
  storagePath: string;
  sizeBytes: number;
  mimeType: string;
}

export async function ensureUploadDirectories(): Promise<void> {
  await fs.mkdir(path.join(env.uploadRoot, PUBLIC_DIR), { recursive: true });
  await fs.mkdir(path.join(env.uploadRoot, PRIVATE_DIR), { recursive: true });
}

// Resolves a stored relative path and refuses anything that escapes the upload folder.
export function resolveStoredPath(storagePath: string): string {
  const absolute = path.resolve(env.uploadRoot, storagePath);
  if (!absolute.startsWith(env.uploadRoot + path.sep)) throw badRequest("Invalid file path");
  return absolute;
}

async function writeFile(storagePath: string, data: Buffer): Promise<void> {
  const absolute = resolveStoredPath(storagePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, data);
}

// Validates the bytes really are an image, then stores a large and a thumbnail version as WebP.
export async function storeImage(
  file: Express.Multer.File,
  folder: string,
  sizes: { large: number; thumb: number } = { large: 1600, thumb: 400 }
): Promise<StoredImage> {
  let large: Buffer;
  let thumb: Buffer;
  try {
    const pipeline = () => sharp(file.buffer, { limitInputPixels: 60_000_000 }).rotate();
    large = await pipeline().resize({ width: sizes.large, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    thumb = await pipeline().resize({ width: sizes.thumb, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  } catch {
    throw badRequest(`"${file.originalname}" is not a valid image`);
  }

  const id = crypto.randomUUID();
  const storagePath = `${PUBLIC_DIR}/${folder}/${id}.webp`;
  const thumbPath = `${PUBLIC_DIR}/${folder}/${id}-thumb.webp`;
  await writeFile(storagePath, large);
  await writeFile(thumbPath, thumb);
  return { storagePath, thumbPath, sizeBytes: large.length };
}

// Stores a PDF or image in the private folder, which is never served statically.
export async function storePrivateFile(file: Express.Multer.File, folder: string): Promise<StoredFile> {
  const isPdf = file.buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  let extension: string;
  let mimeType: string;

  if (isPdf) {
    extension = "pdf";
    mimeType = "application/pdf";
  } else {
    try {
      const metadata = await sharp(file.buffer, { limitInputPixels: 60_000_000 }).metadata();
      if (metadata.format !== "jpeg" && metadata.format !== "png") throw new Error("unsupported");
      extension = metadata.format === "jpeg" ? "jpg" : "png";
      mimeType = metadata.format === "jpeg" ? "image/jpeg" : "image/png";
    } catch {
      throw badRequest(`"${file.originalname}" is not a valid PDF, JPG or PNG`);
    }
  }

  const storagePath = `${PRIVATE_DIR}/${folder}/${crypto.randomUUID()}.${extension}`;
  await writeFile(storagePath, file.buffer);
  return { storagePath, sizeBytes: file.buffer.length, mimeType };
}

export async function removeStoredFiles(...storagePaths: Array<string | null | undefined>): Promise<void> {
  await Promise.all(
    storagePaths
      .filter((value): value is string => Boolean(value))
      .map(async (storagePath) => {
        try {
          await fs.unlink(resolveStoredPath(storagePath));
        } catch {
          // A missing file is not an error when cleaning up.
        }
      })
  );
}

const publicUrl = (storagePath: string) => `/uploads/${storagePath.replace(/^public\//, "")}`;

export function serializeFile(asset: FileAsset) {
  return {
    id: asset.id,
    kind: asset.kind,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    isCover: asset.isCover,
    isPrivate: asset.isPrivate,
    url: asset.isPrivate ? null : publicUrl(asset.storagePath),
    thumbUrl: asset.thumbPath && !asset.isPrivate ? publicUrl(asset.thumbPath) : null,
    downloadUrl: asset.isPrivate ? `/api/files/${asset.id}/download` : null,
    createdAt: asset.createdAt,
  };
}
