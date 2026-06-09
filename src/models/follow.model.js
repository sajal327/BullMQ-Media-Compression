import mongoose from "mongoose";

const followSchema = new mongoose.Schema(
  {
    follower: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    following: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: { type: String, enum: ["PENDING", "ACCEPTED"], default: "PENDING" },
  },
  { timestamps: true },
);

// Mongoose checks if model is already registered before creating a new one.
// This prevents "Cannot overwrite model once compiled" errors.
export const Follow =
  mongoose.models.Follow || mongoose.model("Follow", followSchema);
