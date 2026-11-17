'use strict';

const crypto = require('crypto');
const multer = require('multer');
const { config } = require('../config');
const { friendlyDbError } = require('../supabase');

const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image'));
    }
    return cb(null, true);
  },
});

/** Turn an upload failure into a clear response for the browser. */
function uploadError(res, err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'The image is too large. Maximum size is 5 MB.' });
    }
    return res.status(400).json({ error: 'Only JPG, PNG or WebP images are allowed.' });
  }
  if (err && err.friendly) {
    return res.status(504).json({ error: err.message });
  }
  return res.status(500).json({ error: friendlyDbError(err) });
}

// A stuck upload must answer with a clear error, not spin forever.
const UPLOAD_TIMEOUT_MS = 45000;

function withTimeout(promise, ms, message) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.friendly = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Upload an image to the Supabase storage bucket (creates it if missing) and
 * return its storage path and public URL. `prefix` keeps files grouped
 * (e.g. "menu", "qr").
 */
async function saveImage(sb, file, prefix) {
  const ext = ALLOWED_IMAGE_TYPES[file.mimetype];
  const path = `${prefix}/${crypto.randomUUID()}.${ext}`;
  const options = { contentType: file.mimetype, upsert: false, cacheControl: '31536000' };
  const timeoutMessage = 'The image upload is taking too long. Please check the internet connection and try again.';

  let { error } = await withTimeout(
    sb.storage.from(config.bucket).upload(path, file.buffer, options),
    UPLOAD_TIMEOUT_MS,
    timeoutMessage
  );
  if (error && /bucket not found/i.test(error.message || '')) {
    try {
      await sb.storage.createBucket(config.bucket, {
        public: true,
        fileSizeLimit: MAX_IMAGE_BYTES,
        allowedMimeTypes: Object.keys(ALLOWED_IMAGE_TYPES),
      });
    } catch {
      /* ignored - retry below reports the real error */
    }
    ({ error } = await withTimeout(
      sb.storage.from(config.bucket).upload(path, file.buffer, options),
      UPLOAD_TIMEOUT_MS,
      timeoutMessage
    ));
  }
  if (error) {
    if (error.friendly) throw error;
    throw new Error(friendlyDbError(error));
  }

  const { data } = sb.storage.from(config.bucket).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

/** Best-effort delete of a stored image - a stale file must never fail a save. */
async function removeImage(sb, path) {
  if (!path) return;
  try {
    await sb.storage.from(config.bucket).remove([path]);
  } catch (err) {
    console.warn('[imageUpload] could not remove old image:', err.message);
  }
}

/**
 * Express middleware that accepts one image file and answers rejected uploads
 * (wrong type, too large) with a clear JSON error instead of an HTML page.
 */
function singleImage(field = 'image') {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) return uploadError(res, err);
      return next();
    });
  };
}

module.exports = {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  upload,
  uploadError,
  saveImage,
  removeImage,
  singleImage,
};