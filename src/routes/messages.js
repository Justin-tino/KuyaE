'use strict';

const express = require('express');
const { getClient, friendlyDbError } = require('../supabase');
const { isUuid } = require('../lib/helpers');
const { requireAuth, requireRole } = require('../middleware/auth');
const { publishChange } = require('../realtime');
const {
  RETENTION_MS,
  retentionCutoff,
  expiryOf,
  sweepExpiredConversations,
} = require('../lib/messageRetention');

const router = express.Router();

const MAX_BODY_LENGTH = 2000;

const THREAD_SELECT =
  'id, admin_id, staff_id, last_message_body, last_message_sender_id, unread_for_admin, unread_for_staff, created_at, last_message_at, ' +
  'admin:users!conversations_admin_id_fkey(id, username, full_name, role, is_active), ' +
  'staff:users!conversations_staff_id_fkey(id, username, full_name, role, is_active)';

/**
 * Chat text keeps line breaks (unlike cleanText, which strips them) but drops
 * other control characters and enforces the length limit.
 */
function cleanMessageBody(value) {
  if (value === null || value === undefined) return '';
  let text = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (text.length > MAX_BODY_LENGTH) text = text.slice(0, MAX_BODY_LENGTH);
  return text;
}

function serializeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderRole: row.sender_role,
    body: row.body,
    createdAt: row.created_at,
  };
}

function serializeThread(row, viewerId) {
  const iAmAdmin = row.admin_id === viewerId;
  const other = iAmAdmin ? row.staff : row.admin;
  const otherUser = Array.isArray(other) ? other[0] : other;
  return {
    id: row.id,
    other: otherUser
      ? {
          id: otherUser.id,
          username: otherUser.username,
          fullName: otherUser.full_name,
          role: otherUser.role,
          isActive: otherUser.is_active !== false,
        }
      : null,
    lastMessage: row.last_message_body
      ? {
          body: row.last_message_body,
          senderId: row.last_message_sender_id,
          createdAt: row.last_message_at,
        }
      : null,
    unread: iAmAdmin ? row.unread_for_admin || 0 : row.unread_for_staff || 0,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    expiresAt: expiryOf(row.last_message_at),
  };
}

/** Load one conversation row (raw) or send the proper response. */
async function findConversation(sb, id, res) {
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Invalid conversation.' });
    return null;
  }
  const { data, error } = await sb.from('conversations').select(THREAD_SELECT).eq('id', id).maybeSingle();
  if (error) {
    res.status(503).json({ error: friendlyDbError(error) });
    return null;
  }
  if (!data) {
    res.status(404).json({ error: 'Conversation not found.' });
    return null;
  }
  if (new Date(data.last_message_at).getTime() < Date.now() - RETENTION_MS) {
    res.status(404).json({ error: 'This conversation has expired and was deleted.' });
    return null;
  }
  return data;
}

/** GET /api/messages/unread - badge count for the signed-in user. */
router.get('/unread', requireAuth, async (req, res, next) => {
  try {
    sweepExpiredConversations();
    const sb = getClient();
    const { data, error } = await sb
      .from('conversations')
      .select('id, admin_id, staff_id, unread_for_admin, unread_for_staff')
      .or(`admin_id.eq.${req.user.id},staff_id.eq.${req.user.id}`)
      .gte('last_message_at', retentionCutoff());
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    const unread = (data || []).reduce(
      (sum, row) => sum + (row.admin_id === req.user.id ? row.unread_for_admin || 0 : row.unread_for_staff || 0),
      0
    );
    return res.json({ unread });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/messages/threads - my conversations, newest activity first. */
router.get('/threads', requireAuth, async (req, res, next) => {
  try {
    sweepExpiredConversations();
    const sb = getClient();
    const { data, error } = await sb
      .from('conversations')
      .select(THREAD_SELECT)
      .or(`admin_id.eq.${req.user.id},staff_id.eq.${req.user.id}`)
      .gte('last_message_at', retentionCutoff())
      .order('last_message_at', { ascending: false })
      .limit(50);
    if (error) return res.status(503).json({ error: friendlyDbError(error) });
    return res.json({ threads: (data || []).map((row) => serializeThread(row, req.user.id)) });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/messages/threads/:id - messages in one conversation. Marks it read. */
router.get('/threads/:id', requireAuth, async (req, res, next) => {
  try {
    sweepExpiredConversations();
    const sb = getClient();
    const conversation = await findConversation(sb, req.params.id, res);
    if (!conversation) return undefined;

    const isParticipant = conversation.admin_id === req.user.id || conversation.staff_id === req.user.id;
    if (!isParticipant) return res.status(404).json({ error: 'Conversation not found.' });

    // Clear the badge first: a message that arrives during the fetch bumps the
    // counter again, which is safer than accidentally hiding it.
    const isAdmin = conversation.admin_id === req.user.id;
    const readField = isAdmin ? 'unread_for_admin' : 'unread_for_staff';
    const currentUnread = isAdmin ? conversation.unread_for_admin || 0 : conversation.unread_for_staff || 0;
    if (currentUnread > 0) {
      const { error: readError } = await sb
        .from('conversations')
        .update({ [readField]: 0 })
        .eq('id', conversation.id);
      if (readError) return res.status(500).json({ error: friendlyDbError(readError) });
    }

    const { data: messages, error: messageError } = await sb
      .from('messages')
      .select('id, conversation_id, sender_id, sender_role, body, created_at')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(500);
    if (messageError) return res.status(503).json({ error: friendlyDbError(messageError) });

    const thread = serializeThread(conversation, req.user.id);
    thread.unread = 0;
    return res.json({ thread, messages: (messages || []).map(serializeMessage) });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/messages/threads - admin starts (or reopens) a chat with one staff member. */
router.post('/threads', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    sweepExpiredConversations();
    const staffId = req.body && req.body.staffId;
    const body = cleanMessageBody(req.body && req.body.body);
    if (!isUuid(staffId)) return res.status(400).json({ error: 'Choose who to message.' });
    if (!body) return res.status(400).json({ error: 'Type a message first.' });

    const sb = getClient();
    const { data: staff, error: staffError } = await sb
      .from('users')
      .select('id, full_name, role, is_active')
      .eq('id', staffId)
      .maybeSingle();
    if (staffError) return res.status(503).json({ error: friendlyDbError(staffError) });
    if (!staff || staff.role === 'admin') {
      return res.status(400).json({ error: 'Choose a cashier or kitchen staff member.' });
    }
    if (staff.is_active === false) {
      return res.status(400).json({ error: 'That account is disabled.' });
    }

    let { data: conversation, error: findError } = await sb
      .from('conversations')
      .select(THREAD_SELECT)
      .eq('admin_id', req.user.id)
      .eq('staff_id', staffId)
      .maybeSingle();
    if (findError) return res.status(503).json({ error: friendlyDbError(findError) });

    // An expired chat must not come back to life with its old messages: start
    // a clean conversation instead. (The background sweep may not have run yet.)
    if (conversation && new Date(conversation.last_message_at).getTime() < Date.now() - RETENTION_MS) {
      await sb.from('conversations').delete().eq('id', conversation.id);
      conversation = null;
    }

    let created = false;
    if (!conversation) {
      const { data: inserted, error: insertError } = await sb
        .from('conversations')
        .insert({ admin_id: req.user.id, staff_id: staffId })
        .select(THREAD_SELECT)
        .single();
      if (insertError) {
        if (/duplicate/i.test(String(insertError.message || ''))) {
          // Another tab created it first - use that one.
          const retry = await sb
            .from('conversations')
            .select(THREAD_SELECT)
            .eq('admin_id', req.user.id)
            .eq('staff_id', staffId)
            .maybeSingle();
          if (retry.error) return res.status(503).json({ error: friendlyDbError(retry.error) });
          conversation = retry.data;
        } else {
          return res.status(500).json({ error: friendlyDbError(insertError) });
        }
      } else {
        conversation = inserted;
        created = true;
      }
    }
    if (!conversation) return res.status(500).json({ error: 'Could not start the conversation.' });

    const { data: message, error: messageError } = await sb
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_id: req.user.id,
        sender_role: req.user.role,
        body,
      })
      .select('id, conversation_id, sender_id, sender_role, body, created_at')
      .single();
    if (messageError) {
      // Do not leave an empty conversation behind.
      if (created) await sb.from('conversations').delete().eq('id', conversation.id);
      return res.status(500).json({ error: friendlyDbError(messageError) });
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await sb
      .from('conversations')
      .update({
        last_message_body: body,
        last_message_sender_id: req.user.id,
        last_message_at: now,
        unread_for_staff: (conversation.unread_for_staff || 0) + 1,
      })
      .eq('id', conversation.id)
      .select(THREAD_SELECT)
      .single();
    if (updateError) return res.status(500).json({ error: friendlyDbError(updateError) });

    publishChange('messages', 'INSERT', null);
    return res.status(201).json({
      thread: serializeThread(updated, req.user.id),
      message: serializeMessage(message),
    });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/messages/threads/:id/messages - either participant replies. */
router.post('/threads/:id/messages', requireAuth, async (req, res, next) => {
  try {
    sweepExpiredConversations();
    const body = cleanMessageBody(req.body && req.body.body);
    if (!body) return res.status(400).json({ error: 'Type a message first.' });

    const sb = getClient();
    const conversation = await findConversation(sb, req.params.id, res);
    if (!conversation) return undefined;

    const isAdmin = conversation.admin_id === req.user.id;
    const isStaff = conversation.staff_id === req.user.id;
    if (!isAdmin && !isStaff) return res.status(404).json({ error: 'Conversation not found.' });

    const { data: message, error: messageError } = await sb
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_id: req.user.id,
        sender_role: req.user.role,
        body,
      })
      .select('id, conversation_id, sender_id, sender_role, body, created_at')
      .single();
    if (messageError) return res.status(500).json({ error: friendlyDbError(messageError) });

    const updates = {
      last_message_body: body,
      last_message_sender_id: req.user.id,
      last_message_at: new Date().toISOString(),
    };
    if (isAdmin) updates.unread_for_staff = (conversation.unread_for_staff || 0) + 1;
    else updates.unread_for_admin = (conversation.unread_for_admin || 0) + 1;

    const { data: updated, error: updateError } = await sb
      .from('conversations')
      .update(updates)
      .eq('id', conversation.id)
      .select(THREAD_SELECT)
      .single();
    if (updateError) return res.status(500).json({ error: friendlyDbError(updateError) });

    publishChange('messages', 'INSERT', null);
    return res.status(201).json({
      thread: serializeThread(updated, req.user.id),
      message: serializeMessage(message),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
