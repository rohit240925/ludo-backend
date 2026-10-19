import mongoose from 'mongoose';

export const REWARD_CLAIM_TYPES = ['victory', 'daily'] as const;
export type RewardClaimType = (typeof REWARD_CLAIM_TYPES)[number];

/**
 * One row per granted reward, keyed by (userId, type, key).
 *
 * The unique index is the anti-duplicate guard: a second claim with the same
 * key fails with a duplicate-key error, which the API translates to
 * 409 ALREADY_CLAIMED.
 *
 * Keys: victory -> the match/room code; daily -> YYYY-MM-DD (UTC).
 */
export interface RewardClaimDocument extends mongoose.Document {
  userId: string;
  type: RewardClaimType;
  key: string;
  coins: number;
  claimedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RewardClaimSchema = new mongoose.Schema<RewardClaimDocument>(
  {
    userId: { type: String, required: true },
    type: { type: String, required: true, enum: REWARD_CLAIM_TYPES },
    key: { type: String, required: true },
    coins: { type: Number, required: true, min: 0 },
    claimedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

RewardClaimSchema.index({ userId: 1, type: 1, key: 1 }, { unique: true });

export const RewardClaim =
  (mongoose.models.RewardClaim as mongoose.Model<RewardClaimDocument> | undefined) ??
  mongoose.model<RewardClaimDocument>('RewardClaim', RewardClaimSchema);
