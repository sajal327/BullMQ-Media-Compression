import { Post } from "../models/post.model.js";

export const markCompleted = async (postId, images, video) => {
  await Post.findByIdAndUpdate(postId, {
    $set: {
      images,
      video,
      mediaStatus: "COMPLETED",
      rawImages: [], // ← add
      rawVideo: null, // ← add
    },
  });

  // Re-fetch with user populated so the worker can cache a valid object.
  // findByIdAndUpdate with { new: true } returns the doc but user is a raw
  // ObjectId — every downstream cache check (parsed.user._id) would fail.
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

// import { Post } from "../models/post.model.js";

// export const markCompleted = async (postId, images, video) => {
//   return Post.findByIdAndUpdate(
//     postId,
//     {
//       $set: {
//         images,
//         video,
//         mediaStatus: "COMPLETED",
//       },
//     },
//     { new: true },
//   );
// };

// export const markFailed = async (postId) => {
//   return Post.findByIdAndUpdate(postId, {
//     $set: {
//       mediaStatus: "FAILED",
//     },
//   });
// };
