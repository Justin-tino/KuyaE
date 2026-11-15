'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const { config } = require('../config');
const { getClient, friendlyDbError } = require('../supabase');
const { auditLog } = require('../lib/audit');
const { cleanText, firstZodError, isUuid, toCents } = require('../lib/helpers');
const { serializeMenuItem } = require('../lib/serialize');
const { requireAuth, requireRole } = require('../middleware/auth');
const { publishChange } = require('../realtime');

const router = express.Router();

const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image'));
    }
    return cb(null, true);
  },
});

const priceSchema = z.coerce
  .number({ invalid_type_error: 'Price must be a number' })
  .positive('Price must be greater than 0')
  .max(1000000, 'Price is too large');

const availabilitySchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const menuSchema = z.object({
  name: z.string().trim().min(1, 'Menu name is required').max(80, 'Name is too long'),
  description: z.string().trim().max(300, 'Description is too long').default(''),
  category: z.string().trim().min(1, 'Category is required').max(40, 'Category is too long'),
  price: priceSchema,
  isAvailable: availabilitySchema.default(true),
});

const MENU_SELECT = 'id, name, description, category, price, image_path, image_url, is_available, created_at, updated_at';

function uploadError(res, err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'The photo is too large. Maximum size is 5 MB.' });
    }
    return res.status(400).json({ error: 'Only JPG, PNG or WebP photos are allowed.' });
  }
  if (err && err.friendly) {
    return res.status(504).json({ error: err.message });
  }
  return res.status(500).json({ error: friendlyDbError(err) });
}

// A stuck photo upload must answer with a clear error, not spin forever.
const PHOTO_UPLOAD_TIMEOUT_MS = 45000;

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

/** Upload a menu photo to the Supabase storage bucket (creates it if missing). */
async function saveMenuImage(sb, file) {
  const ext = ALLOWED_IMAGE_TYPES[file.mimetype];
  const path = `${crypto.randomUUID()}.${ext}`;
  const options = { contentType: file.mimetype, upsert: false, cacheControl: '31536000' };
  const timeoutMessage =
    'The photo upload is taking too long. Please check the internet connection and try again.';

  let { error } = await withTimeout(
    sb.storage.from(config.bucket).upload(path, file.buffer, options),
    PHOTO_UPLOAD_TIMEOUT_MS,
    timeoutMessage
  );
  if (error && /bucket not found/i.test(error.message || '')) {
    try {
      await sb.storage.createBucket(config.bucket, {
        public: true,
        fileSizeLimit: 5242880,
        allowedMimeTypes: Object.keys(ALLOWED_IMAGE_TYPES),
      });
    } catch {
      /* ignored - retry below reports the real error */
    }
    ({ error } = await withTimeout(
      sb.storage.from(config.bucket).upload(path, file.buffer, options),
      PHOTO_UPLOAD_TIMEOUT_MS,
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

async function removeMenuImage(sb, path) {
  if (!path) return;
  try {
    await sb.storage.from(config.bucket).remove([path]);
  } catch (err) {
    console.warn('[menu] could not remove old image:', err.message);
  }
}

/** GET /api/menu - everyone signed in can see the menu. */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const sb = getClient();
    let query = sb.from('menu_items').select(MENU_SELECT).order('category').order('name');
    if (req.query.available === 'true') query = query.eq('is_available', true);
    const { data, error } = await query;
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    return res.json({ items: (data || []).map(serializeMenuItem) });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/menu - admin only. Multipart (with photo) or plain JSON. */
router.post('/', requireAuth, requireRole('admin'), upload.single('image'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const parsed = menuSchema.safeParse({
      name: cleanText(body.name, 80),
      description: cleanText(body.description, 300),
      category: cleanText(body.category, 40) || 'Meals',
      price: body.price,
      isAvailable: body.isAvailable === undefined ? true : body.isAvailable,
    });
    if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });

    const sb = getClient();
    let image = { path: null, url: null };
    if (req.file) {
      try {
        image = await saveMenuImage(sb, req.file);
      } catch (err) {
        return uploadError(res, err);
      }
    }

    const { data, error } = await sb
      .from('menu_items')
      .insert({
        name: parsed.data.name,
        description: parsed.data.description,
        category: parsed.data.category,
        price: parsed.data.price.toFixed(2),
        is_available: parsed.data.isAvailable,
        image_path: image.path,
        image_url: image.url,
      })
      .select(MENU_SELECT)
      .single();
    if (error) return res.status(500).json({ error: friendlyDbError(error) });

    auditLog(req, 'menu_create', 'menu_item', data.id, {
      name: data.name,
      category: data.category,
      priceCents: toCents(data.price),
    });
    publishChange('menu_items', 'INSERT');
    return res.status(201).json({ item: serializeMenuItem(data) });
  } catch (err) {
    return next(err);
  }
});

/** PATCH /api/menu/:id - admin only. */
router.patch('/:id', requireAuth, requireRole('admin'), upload.single('image'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid menu item.' });

    const sb = getClient();
    const { data: existing, error: findError } = await sb
      .from('menu_items')
      .select(MENU_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (findError) return res.status(503).json({ error: friendlyDbError(findError) });
    if (!existing) return res.status(404).json({ error: 'Menu item not found.' });

    const body = req.body || {};
    const updates = {};
    if (body.name !== undefined) updates.name = cleanText(body.name, 80);
    if (body.description !== undefined) updates.description = cleanText(body.description, 300);
    if (body.category !== undefined) updates.category = cleanText(body.category, 40) || 'Meals';
    if (body.price !== undefined) {
      const price = priceSchema.safeParse(body.price);
      if (!price.success) return res.status(400).json({ error: firstZodError(price.error) });
      updates.price = price.data.toFixed(2);
    }
    if (body.isAvailable !== undefined) {
      const avail = availabilitySchema.safeParse(body.isAvailable);
      if (!avail.success) return res.status(400).json({ error: 'Invalid availability value.' });
      updates.is_available = avail.data;
    }
    if (updates.name !== undefined && !updates.name) {
      return res.status(400).json({ error: 'Menu name is required.' });
    }

    let oldImagePath = null;
    if (req.file) {
      try {
        const image = await saveMenuImage(sb, req.file);
        updates.image_path = image.path;
        updates.image_url = image.url;
        oldImagePath = existing.image_path;
      } catch (err) {
        return uploadError(res, err);
      }
    }
    if (body.removeImage === 'true' || body.removeImage === true) {
      updates.image_path = null;
      updates.image_url = null;
      oldImagePath = existing.image_path;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { data, error } = await sb.from('menu_items').update(updates).eq('id', id).select(MENU_SELECT).single();
    if (error) return res.status(500).json({ error: friendlyDbError(error) });
    // Best-effort cleanup after the response - the item is already saved.
    if (oldImagePath) removeMenuImage(sb, oldImagePath);

    auditLog(req, 'menu_update', 'menu_item', id, {
      name: data.name,
      changed: Object.keys(updates),
      priceCents: toCents(data.price),
    });
    publishChange('menu_items', 'UPDATE');
    return res.json({ item: serializeMenuItem(data) });
  } catch (err) {
    return next(err);
  }
});

/** DELETE /api/menu/:id - admin only. */
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid menu item.' });

    const sb = getClient();
    const { data: existing, error: findError } = await sb
      .from('menu_items')
      .select(MENU_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (findError) return res.status(503).json({ error: friendlyDbError(findError) });
    if (!existing) return res.status(404).json({ error: 'Menu item not found.' });

    const { error } = await sb.from('menu_items').delete().eq('id', id);
    if (error) return res.status(500).json({ error: friendlyDbError(error) });
    removeMenuImage(sb, existing.image_path);

    auditLog(req, 'menu_delete', 'menu_item', id, { name: existing.name, category: existing.category });
    publishChange('menu_items', 'DELETE');
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
