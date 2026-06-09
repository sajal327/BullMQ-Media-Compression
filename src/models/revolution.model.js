import mongoose from "mongoose";

const RevolutionSchema = new mongoose.Schema(
  {
    files: {
      raw: [String],
      processed: [String],
    },

    mediaStatus: {
      type: String,
      enum: ["PROCESSING", "COMPLETED", "FAILED"],
      default: "PROCESSING",
      index: true,
    },
  },
  { timestamps: true },
);

RevolutionSchema.set("strict", false);

export const Revolution = mongoose.model(
  "Revolution",
  RevolutionSchema,
  "revolutions",
);
