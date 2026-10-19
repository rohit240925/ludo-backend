import mongoose from 'mongoose';

export const LEDGER_REASONS = [
  'daily_reward',
  'victory_bonus',
  'room_entry',
  'room_entry_refund',
  'room_win',
  'admin_grant',
  'admin_deduct',
] as const;

export type LedgerReason = (typeof LEDGER_REASONS)[number];

export interface LedgerEntryDocument extends mongoose.Document {
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  meta?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const LedgerEntrySchema = new mongoose.Schema<LedgerEntryDocument>(
  {
    userId: { type: String, required: true, index: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    reason: { type: String, required: true, enum: LEDGER_REASONS },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

export const LedgerEntry =
  (mongoose.models.LedgerEntry as mongoose.Model<LedgerEntryDocument> | undefined) ??
  mongoose.model<LedgerEntryDocument>('LedgerEntry', LedgerEntrySchema);
