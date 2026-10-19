import mongoose from 'mongoose';

export const LEADERBOARD_SCOPES = ['daily', 'weekly', 'monthly', 'alltime'] as const;
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number];

/**
 * Per-user leaderboard aggregates, one document per (user, scope, period).
 *
 * Periods (UTC):
 *   daily   -> YYYY-MM-DD
 *   weekly  -> YYYY-Www (ISO week)
 *   monthly -> YYYY-MM
 *   alltime -> 'all'
 *
 * Updated from the game_over persist hook; displayName is refreshed from the
 * room so the board always shows the latest name.
 */
export interface MatchStatsDocument extends mongoose.Document {
  userId: string;
  displayName: string;
  scope: LeaderboardScope;
  period: string;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  points: number;
  updatedAt: Date;
  createdAt: Date;
}

const MatchStatsSchema = new mongoose.Schema<MatchStatsDocument>(
  {
    userId: { type: String, required: true },
    displayName: { type: String, default: '' },
    scope: { type: String, required: true, enum: LEADERBOARD_SCOPES },
    period: { type: String, required: true },
    matchesPlayed: { type: Number, default: 0, min: 0 },
    matchesWon: { type: Number, default: 0, min: 0 },
    matchesLost: { type: Number, default: 0, min: 0 },
    points: { type: Number, default: 0 },
  },
  { timestamps: true },
);

MatchStatsSchema.index({ userId: 1, scope: 1, period: 1 }, { unique: true });
MatchStatsSchema.index({ scope: 1, period: 1, points: -1 });

export const MatchStats =
  (mongoose.models.MatchStats as mongoose.Model<MatchStatsDocument> | undefined) ??
  mongoose.model<MatchStatsDocument>('MatchStats', MatchStatsSchema);
