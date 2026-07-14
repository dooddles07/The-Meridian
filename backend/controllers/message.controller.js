const mongoose     = require('mongoose');
const Conversation = require('../models/conversation.model');
const residents    = require('../services/residents.service');

const dbReady = () => mongoose.connection.readyState === 1;

function convoMeta(c) {
  return {
    id: String(c._id), contact_id: c.contact_id, resident_name: c.resident_name,
    resident_unit: c.resident_unit, resident_email: c.resident_email,
    last_message_at: c.last_message_at, last_message_preview: c.last_message_preview,
    last_sender: c.last_sender, unread_management: c.unread_management,
    unread_resident: c.unread_resident, resolved: c.resolved,
    resident_last_read_at: c.resident_last_read_at, management_last_read_at: c.management_last_read_at,
  };
}
function pushMessage(c, sender, sender_name, body) {
  const msg = { sender, sender_name, body, createdAt: new Date() };
  c.messages.push(msg);
  c.last_message_at = msg.createdAt;
  c.last_message_preview = body.slice(0, 80);
  c.last_sender = sender;
  return c.messages[c.messages.length - 1];
}
function cleanBody(v) { return String(v || '').trim().slice(0, 4000); }

// ---- Resident ----

// GET /api/messages/mine — resident's own thread (reading clears their unread).
async function mine(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const c = await Conversation.findOne({ contact_id: req.resident.contact_id });
  if (!c) return res.json({ success: true, conversation: null, messages: [], unread: 0 });
  // Opening the thread marks all of management's messages read.
  c.unread_resident = 0;
  c.resident_last_read_at = new Date();
  await c.save();
  return res.json({ success: true, conversation: convoMeta(c), messages: c.messages, unread: 0 });
}

// GET /api/messages/unread — count only, no clear (drives the sidebar badge).
async function unread(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const c = await Conversation.findOne({ contact_id: req.resident.contact_id }).lean();
  return res.json({ success: true, unread: c ? (c.unread_resident || 0) : 0 });
}

// POST /api/messages — resident sends (find-or-create their thread).
async function send(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const body = cleanBody(req.body.body);
  if (!body) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
  let c = await Conversation.findOne({ contact_id: req.resident.contact_id });
  if (!c) {
    c = new Conversation({
      contact_id: req.resident.contact_id, resident_name: req.resident.name,
      resident_email: req.resident.email, resident_unit: req.resident.unit,
    });
  }
  const msg = pushMessage(c, 'resident', req.resident.name, body);
  c.unread_management += 1;
  c.resolved = false;
  await c.save();
  return res.json({ success: true, message: msg });
}

// ---- Management ----

// GET /api/management/messages
async function listForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const convos = await Conversation.find({}).sort({ last_message_at: -1, updatedAt: -1 }).lean();
  const total_unread = convos.reduce((s, c) => s + (c.unread_management || 0), 0);
  return res.json({ success: true, conversations: convos.map(convoMeta), total_unread });
}

// GET /api/management/messages-residents — directory for starting a thread.
async function residentDirectory(req, res) {
  const rows = await residents.listResidents();
  return res.json({
    success: true,
    residents: (rows || []).map(r => ({ name: r.name, unit: r.unit, email: r.email, contact_id: String(r._id || r.contact_id || '') })),
  });
}

// GET /api/management/messages/:id — open a thread (clears management unread).
async function getOne(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const c = await Conversation.findById(req.params.id);
  if (!c) return res.status(404).json({ success: false, message: 'Conversation not found.' });
  // Opening the thread marks all of the resident's messages read.
  c.unread_management = 0;
  c.management_last_read_at = new Date();
  await c.save();
  return res.json({ success: true, conversation: convoMeta(c), messages: c.messages });
}

// POST /api/management/messages/:id/reply
async function reply(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const body = cleanBody(req.body.body);
  if (!body) return res.status(400).json({ success: false, message: 'Reply cannot be empty.' });
  const c = await Conversation.findById(req.params.id);
  if (!c) return res.status(404).json({ success: false, message: 'Conversation not found.' });
  const msg = pushMessage(c, 'management', 'Management', body);
  c.unread_resident += 1;
  await c.save();
  return res.json({ success: true, message: msg });
}

// POST /api/management/messages/:id/resolve
async function resolve(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const c = await Conversation.findById(req.params.id);
  if (!c) return res.status(404).json({ success: false, message: 'Conversation not found.' });
  c.resolved = req.body.resolved != null ? !!req.body.resolved : true;
  await c.save();
  return res.json({ success: true, conversation: convoMeta(c) });
}

// POST /api/management/messages/start — management opens a thread with a resident.
async function start(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const body = cleanBody(req.body.body);
  if (!body) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
  const contact_id = String(req.body.contact_id || '').trim();
  if (!contact_id) return res.status(400).json({ success: false, message: 'A resident is required.' });
  let c = await Conversation.findOne({ contact_id });
  if (!c) {
    c = new Conversation({
      contact_id,
      resident_name:  String(req.body.resident_name || '').trim(),
      resident_email: String(req.body.resident_email || '').trim(),
      resident_unit:  String(req.body.resident_unit || '').trim(),
    });
  }
  const msg = pushMessage(c, 'management', 'Management', body);
  c.unread_resident += 1;
  c.resolved = false;
  await c.save();
  return res.json({ success: true, message: msg, conversation_id: String(c._id) });
}

module.exports = { mine, unread, send, listForManagement, residentDirectory, getOne, reply, resolve, start };
