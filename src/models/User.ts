import mongoose from 'mongoose';

export interface UserDocument extends mongoose.Document {
  userId: string;
  displayName: string;
  coins: number;
  /** Last daily-claim date as YYYY-MM-DD (UTC), or null if never claimed. */
  lastClaimDate: string | null;
  streakDays: number;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new mongoose.Schema<UserDocument>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, default: '' },
    coins: { type: Number, default: 0, min: 0 },
    lastClaimDate: { type: String, default: null },
    streakDays: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export const User =
  (mongoose.models.User as mongoose.Model<UserDocument> | undefined) ??
  mongoose.model<UserDocument>('User', UserSchema);
