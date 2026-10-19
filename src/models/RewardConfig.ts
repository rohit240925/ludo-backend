import mongoose from 'mongoose';

export interface RewardConfigDocument extends mongoose.Document {
  day: number;
  coins: number;
}

const RewardConfigSchema = new mongoose.Schema<RewardConfigDocument>(
  {
    day: { type: Number, required: true, unique: true, min: 1 },
    coins: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

export const RewardConfig =
  (mongoose.models.RewardConfig as mongoose.Model<RewardConfigDocument> | undefined) ??
  mongoose.model<RewardConfigDocument>('RewardConfig', RewardConfigSchema);
