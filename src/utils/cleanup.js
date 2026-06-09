import fs from "fs";

export const safeUnlink = async (filePath) => {
  if (!filePath) return;

  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("Cleanup failed:", err.message);
    }
  }
};

export const safeUnlinkMany = async (paths = []) => {
  await Promise.all(paths.map((p) => safeUnlink(p)));
};
