import mongoose from 'mongoose';
import { config } from './config.js';

/**
 * MongoDB is OPTIONAL. The game server is fully functional without it:
 * rooms and live game state live in memory; only match-history persistence
 * is skipped when no database is configured.
 */
export async function connectDb(): Promise<boolean> {
  if (!config.mongoUri) {
    console.warn('[db] MONGODB_URI not set — persistence disabled, rooms are in-memory only');
    return false;
  }
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.log('[db] MongoDB connected');
    return true;
  } catch (e) {
    console.warn('[db] MongoDB connection failed — continuing without persistence:', (e as Error).message);
    return false;
  }
}

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
