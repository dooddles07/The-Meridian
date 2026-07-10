// PORTFOLIO DEMO: all IDs below are placeholders — the original tenant's CRM
// identifiers have been removed. This file is reference only; the demo doesn't
// talk to any CRM.

const env = (k, d) => process.env[k] || d;

const PIPELINES = {
  defect: {
    id:   env('MERIDIAN_PIPELINE_DEFECT', 'demo-pipeline-defect'),
    name: 'Defect Tracking',
    stages: {
      'Reported':     'demo-defect-reported',
      'Acknowledged': 'demo-defect-acknowledged',
      'In Progress':  'demo-defect-in-progress',
      'Resolved':     'demo-defect-resolved',
      'Closed':       'demo-defect-closed',
    },
  },
  facility: {
    id:   env('MERIDIAN_PIPELINE_FACILITY', 'demo-pipeline-facility'),
    name: 'Facility Bookings',
    stages: {
      'Deposit Pending': 'demo-facility-deposit-pending',
      'Confirmed':       'demo-facility-confirmed',
      'Completed':       'demo-facility-completed',
      'No-Show':         'demo-facility-no-show',
      'Cancelled':       'demo-facility-cancelled',
    },
  },
  feedback: {
    id:   env('MERIDIAN_PIPELINE_FEEDBACK', 'demo-pipeline-feedback'),
    name: 'Feedback',
    stages: {
      'Submitted':    'demo-feedback-submitted',
      'Under Review': 'demo-feedback-under-review',
      'Resolved':     'demo-feedback-resolved',
      'Closed':       'demo-feedback-closed',
    },
  },
  guest: {
    id:   env('MERIDIAN_PIPELINE_GUEST', 'demo-pipeline-guest'),
    name: 'Guest Registrations',
    stages: {
      'Registered':  'demo-guest-registered',
      'Checked In':  'demo-guest-checked-in',
      'Checked Out': 'demo-guest-checked-out',
      'Departed':    'demo-guest-departed',
      'Closed':      'demo-guest-closed',
    },
  },
  move: {
    id:   env('MERIDIAN_PIPELINE_MOVE', 'demo-pipeline-move'),
    name: 'Move-In / Move-Out',
    stages: {
      'Deposit Pending':  'demo-move-deposit-pending',
      'Confirmed':        'demo-move-confirmed',
      'Completed':        'demo-move-completed',
      'Deposit Refunded': 'demo-move-deposit-refunded',
    },
  },
  parcel: {
    id:   env('MERIDIAN_PIPELINE_PARCEL', 'demo-pipeline-parcel'),
    name: 'Parcel Tracking',
    stages: {
      'Received':               'demo-parcel-received',
      'Notified':               'demo-parcel-notified',
      'Collected':              'demo-parcel-collected',
      'Uncollected / Returned': 'demo-parcel-returned',
    },
  },
};

const getPipeline  = (key) => PIPELINES[key] || null;
const getStageId   = (key, stageName) => { const p = PIPELINES[key]; return p ? (p.stages[stageName] || null) : null; };
const firstStageId = (key) => { const p = PIPELINES[key]; return p ? Object.values(p.stages)[0] : null; };
const listKeys     = () => Object.keys(PIPELINES);

module.exports = { PIPELINES, getPipeline, getStageId, firstStageId, listKeys };
