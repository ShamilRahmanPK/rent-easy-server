export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, message, details);
export const unauthorized = (message = "Not authenticated") => new AppError(401, message);
export const forbidden = (message = "Forbidden") => new AppError(403, message);
export const notFound = (message = "Not found") => new AppError(404, message);
export const conflict = (message: string) => new AppError(409, message);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, message, details);
export const tooManyRequests = (message: string) => new AppError(429, message);
