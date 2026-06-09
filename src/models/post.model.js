import mongoose from "mongoose";

const PostSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    images: [String],
    video: String,
    mediaStatus: {
      type: String,
      enum: ["PROCESSING", "COMPLETED", "FAILED"],
      default: "PROCESSING",
      index: true,
    },
  },
  { timestamps: true },
);
PostSchema.set("strict", false);

export const Post = mongoose.model("Post", PostSchema, "posts");
