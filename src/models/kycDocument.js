import mongoose from "mongoose";

const KycDocumentSchema = new mongoose.Schema(
  {
    frontImage: String,

    backImage: String,

    mediaStatus: {
      type: String,
      enum: ["PROCESSING", "COMPLETED", "FAILED"],
      default: "PROCESSING",
      index: true,
    },

    mediaVersion: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
  },
);

// Allow unknown fields from main DB schema
KycDocumentSchema.set("strict", false);

export default mongoose.model("KycDocument", KycDocumentSchema, "kycdocuments");
