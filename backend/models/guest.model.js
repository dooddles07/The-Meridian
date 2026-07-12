const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  reference:      { type: String, required: true, unique: true, index: true }, // "GST-YYYYMMDD-####"
  visitorName:    { type: String, required: true },
  visitorEmail:   { type: String, default: '' },
  visitorPhone:   { type: String, default: '' },
  visitorType:    { type: String, enum: ['Social Guest', 'Contractor', 'Delivery', 'Mover', 'Other'], default: 'Other' },
  visitDate:      { type: String, required: true }, // YYYY-MM-DD, SGT calendar date
  visitTime:      { type: String, default: '' },
  duration:       { type: String, default: 'Single Visit (Day)' },
  stage:          { type: String, enum: ['Registered', 'Checked In', 'Checked Out', 'Departed', 'Closed'], default: 'Registered' },
  // Snapshotted at registration (not a live ref) - same reasoning as booking.model's
  // facilityName: a booking renamed/cancelled later shouldn't change what this pass says.
  linkedBookingId:{ type: String, default: '' },
  linkedFacility: { type: String, default: '' },
  linkedDate:     { type: String, default: '' },
  contact_id:     { type: String, required: true, index: true }, // resident's own Mongo _id
  host_name:      { type: String, default: '' },
  host_email:     { type: String, default: '' },
  host_unit:      { type: String, default: '' },
  // 'management' when the front-desk registers on a resident's behalf, instead of
  // the resident doing it themselves - see guest.controller.js's two create paths.
  createdVia:     { type: String, enum: ['resident', 'management'], default: 'resident' },
  visitorIc:      { type: String, default: '' },
  visitorVehicle: { type: String, default: '' },
  notes:          { type: String, default: '' },
  checkedInAt:    { type: Date, default: null },
  checkedOutAt:   { type: Date, default: null },
  departedAt:     { type: Date, default: null },
  createdAt:      { type: Date, default: Date.now },
});

module.exports = mongoose.models.Guest || mongoose.model('Guest', schema);
