const mongoose = require('mongoose');

// One conversation thread per resident (keyed by GHL contact_id, email fallback).
// Acts like a support inbox: resident ↔ management exchange messages in one thread.
const conversationSchema = new mongoose.Schema({
  contact_id:           { type: String, default: '' },   // resident GHL contact id (primary key when present)
  resident_email:       { type: String, default: '' },   // fallback key + lookup
  resident_name:        { type: String, default: '' },
  resident_unit:        { type: String, default: '' },
  last_message_at:      { type: Date },
  last_message_preview: { type: String, default: '' },
  last_sender:          { type: String, enum: ['resident', 'management'], default: 'resident' },
  unread_resident:      { type: Number, default: 0 },     // messages the resident hasn't read (sent by management)
  unread_management:    { type: Number, default: 0 },     // messages management hasn't read (sent by resident)
  resolved:             { type: Boolean, default: false }, // management marked the issue as resolved
  resolved_at:          { type: Date },
  active:               { type: Boolean, default: true },
}, { timestamps: true });

conversationSchema.index({ contact_id: 1 });
conversationSchema.index({ resident_email: 1 });
conversationSchema.index({ last_message_at: -1 });

const messageSchema = new mongoose.Schema({
  conversation_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  sender:          { type: String, enum: ['resident', 'management'], required: true },
  sender_name:     { type: String, default: '' },
  body:            { type: String, required: true, trim: true },
}, { timestamps: true });

const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
const Message      = mongoose.models.Message      || mongoose.model('Message', messageSchema);

module.exports = { Conversation, Message };
