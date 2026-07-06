import { Post } from "../models/post.model.js";

export const markCompleted = async (
  postId,
  images,
  imageThumbnails,
  video,
  videoThumbnail,
) => {
  await Post.findByIdAndUpdate(postId, {
    $set: {
      images,
      imageThumbnails,

      video,
      videoThumbnail,

      mediaStatus: "COMPLETED",

      rawImages: [],
      rawVideo: null,
    },
  });

  return Post.findById(postId)
    .populate({
      path: "user",
      match: { isActive: true, isDeleted: false },
      select:
        "_id fullName profilePic isBatch adhaarVerified isActive isDeleted isProfileLocked role",
    })
    .lean();
};

export const markFailed = async (postId) => {
  return Post.findByIdAndUpdate(postId, {
    $set: {
      mediaStatus: "FAILED",
    },
  });
};
