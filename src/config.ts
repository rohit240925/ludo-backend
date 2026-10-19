import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  /** Empty string = run without MongoDB (rooms stay in-memory, no persistence). */
  mongoUri: process.env.MONGODB_URI ?? '',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
};
