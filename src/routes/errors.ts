import { Response } from 'express';

/**
 * Map known domain errors to HTTP responses. Returns true when the error
 * was handled; otherwise the caller should fall through to a 500.
 */
export function mapRouteError(res: Response, e: unknown): boolean {
  const code = (e as Error).message;
  switch (code) {
    case 'DB_REQUIRED':
      res.status(503).json({ code: 'DB_REQUIRED' });
      return true;
    case 'USER_NOT_FOUND':
      res.status(404).json({ code: 'USER_NOT_FOUND' });
      return true;
    case 'INSUFFICIENT_COINS':
      res.status(400).json({ code: 'INSUFFICIENT_COINS' });
      return true;
    default:
      return false;
  }
}
