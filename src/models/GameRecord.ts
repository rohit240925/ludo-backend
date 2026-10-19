import mongoose from 'mongoose';

const MoveSchema = new mongoose.Schema(
  {
    player: { type: Number, required: true },
    tokenIndex: { type: Number, required: true },
    roll: { type: Number, required: true },
    from: { type: Number, required: true },
    to: { type: Number, required: true },
    captured: { type: Number, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const GameRecordSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, index: true },
    numPlayers: { type: Number, required: true },
    playerNames: { type: [String], required: true },
    winner: { type: Number, default: null },
    moves: { type: [MoveSchema], default: [] },
    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true },
);

export const GameRecord =
  mongoose.models.GameRecord ?? mongoose.model('GameRecord', GameRecordSchema);
