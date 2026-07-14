const mongoose = require('mongoose');

// One conversation per resident (keyed by contact_id = String(resident._id)) —
// a single "Management" thread on the resident side, listed among all threads
// on the management side. Messages are embedded (bounded per resident).
const messageSchema = new mongoose.Schema({
  sender:      { type: String, enum: ['resident', 'management'], required: true },
  sender_name: { type: String, default: '' },
  body:        { type: String, required: true },
  createdAt:   { type: Date, default: Date.now },
});

const schema = new mongoose.Schema({
  contact_id:           { type: String, required: true, unique: true, index: true },
  resident_name:        { type: String, default: '' },
  resident_email:       { type: String, default: '' },
  resident_unit:        { type: String, default: '' },
  messages:             [messageSchema],
  // Unread counters: unread_management = resident messages management hasn't
  // opened; unread_resident = management messages the resident hasn't read.
  unread_management:    { type: Number, default: 0 },
  unread_resident:      { type: Number, default: 0 },
  resolved:             { type: Boolean, default: false },
  last_message_at:      { type: Date, default: null },
  last_message_preview: { type: String, default: '' },
  last_sender:          { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.Conversation || mongoose.model('Conversation', schema);
