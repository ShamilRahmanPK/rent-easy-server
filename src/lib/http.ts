import type { Request } from "express";
import { badRequest } from "./errors.js";

// Express types route parameters as string or string[]; ours are always single values.
export function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || value.length === 0) throw badRequest(`Missing "${name}" in the URL`);
  return value;
}
