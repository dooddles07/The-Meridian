// controllers/pipeline.controller.js
const { PIPELINES } = require('../config/pipelines');
const ghl = require('../services/ghl.service');

// GET /api/pipelines — the configured pipeline map the website uses.
function listPipelines(req, res) {
  const out = {};
  for (const [key, p] of Object.entries(PIPELINES)) {
    out[key] = { id: p.id, name: p.name, stages: Object.keys(p.stages) };
  }
  res.json({ success: true, count: Object.keys(out).length, pipelines: out });
}

// GET /api/pipelines/verify — live-check the configured IDs against GHL.
async function verifyPipelines(req, res) {
  if (!ghl.isConfigured()) {
    return res.status(503).json({ success: false, message: 'GHL API key not configured on the server.' });
  }
  try {
    const data = await ghl.ghlGet('/opportunities/pipelines', { params: { locationId: ghl.LOCATION } });
    const live = {};
    (data.pipelines || []).forEach(p => {
      live[p.id] = { name: p.name, stages: (p.stages || []).map(s => ({ name: s.name, id: s.id })) };
    });

    const report = {};
    let allOk = true;

    for (const [key, p] of Object.entries(PIPELINES)) {
      const liveP = live[p.id];
      if (!liveP) {
        report[key] = { ok: false, issue: `Pipeline ID ${p.id} not found in GHL.` };
        allOk = false;
        continue;
      }
      const stageIssues = Object.entries(p.stages)
        .filter(([name, id]) => {
          const ls = liveP.stages.find(s => s.name === name);
          return !ls || ls.id !== id;
        })
        .map(([name]) => name);

      const nameMatch = liveP.name === p.name;
      const ok = nameMatch && stageIssues.length === 0;
      if (!ok) allOk = false;

      report[key] = {
        ok,
        configName:    p.name,
        liveName:      liveP.name,
        nameMatch,
        stageIssues,                                  // stages in config that don't match live
        liveStages:    liveP.stages.map(s => s.name),
      };
    }

    res.json({ success: true, allOk, report });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    res.status(502).json({ success: false, message: `Pipeline verify failed: ${msg}` });
  }
}

module.exports = { listPipelines, verifyPipelines };
