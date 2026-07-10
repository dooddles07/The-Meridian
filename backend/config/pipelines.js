// PORTFOLIO PROJECT: all IDs below are placeholders — the original tenant's CRM
// identifiers have been removed. This file is reference only; this build doesn't
// talk to any CRM.

const env = (k, d) => process.env[k] || d;

const PIPELINES = {
  defect: {
    id:   env('LUMINA_PIPELINE_DEFECT', 'local-pipeline-defect'),
    name: 'Defect Tracking',
    stages: {
      'Reported':     'local-defect-reported',
      'Acknowledged': 'local-defect-acknowledged',
      'In Progress':  'local-defect-in-progress',
      'Resolved':     'local-defect-resolved',
      'Closed':       'local-defect-closed',
    },
  },
  facility: {
    id:   env('LUMINA_PIPELINE_FACILITY', 'local-pipeline-facility'),
    name: 'Facility Bookings',
    stages: {
      'Deposit Pending': 'local-facility-deposit-pending',
      'Confirmed':       'local-facility-confirmed',
      'Completed':       'local-facility-completed',
      'No-Show':         'local-facility-no-show',
      'Cancelled':       'local-facility-cancelled',
    },
  },
  feedback: {
    id:   env('LUMINA_PIPELINE_FEEDBACK', 'local-pipeline-feedback'),
    name: 'Feedback',
    stages: {
      'Submitted':    'local-feedback-submitted',
      'Under Review': 'local-feedback-under-review',
      'Resolved':     'local-feedback-resolved',
      'Closed':       'local-feedback-closed',
    },
  },
  guest: {
    id:   env('LUMINA_PIPELINE_GUEST', 'local-pipeline-guest'),
    name: 'Guest Registrations',
    stages: {
      'Registered':  'local-guest-registered',
      'Checked In':  'local-guest-checked-in',
      'Checked Out': 'local-guest-checked-out',
      'Departed':    'local-guest-departed',
      'Closed':      'local-guest-closed',
    },
  },
  move: {
    id:   env('LUMINA_PIPELINE_MOVE', 'local-pipeline-move'),
    name: 'Move-In / Move-Out',
    stages: {
      'Deposit Pending':  'local-move-deposit-pending',
      'Confirmed':        'local-move-confirmed',
      'Completed':        'local-move-completed',
      'Deposit Refunded': 'local-move-deposit-refunded',
    },
  },
  parcel: {
    id:   env('LUMINA_PIPELINE_PARCEL', 'local-pipeline-parcel'),
    name: 'Parcel Tracking',
    stages: {
      'Received':               'local-parcel-received',
      'Notified':               'local-parcel-notified',
      'Collected':              'local-parcel-collected',
      'Uncollected / Returned': 'local-parcel-returned',
    },
  },
};

const getPipeline  = (key) => PIPELINES[key] || null;
const getStageId   = (key, stageName) => { const p = PIPELINES[key]; return p ? (p.stages[stageName] || null) : null; };
const firstStageId = (key) => { const p = PIPELINES[key]; return p ? Object.values(p.stages)[0] : null; };
const listKeys     = () => Object.keys(PIPELINES);

module.exports = { PIPELINES, getPipeline, getStageId, firstStageId, listKeys };
