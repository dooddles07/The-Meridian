const mongoose = require('mongoose');

// Was copy-pasted as `const dbReady = () => mongoose.connection.readyState === 1;`
// at the top of every controller - one shared definition here instead. Callers
// keep their own `if (!dbReady()) return res.status(503)...` guard exactly as
// before (including booking.controller.js#availability's deliberate fail-open
// exception) - only the check itself moved, not how each route reacts to it.
function isDbReady() {
  return mongoose.connection.readyState === 1;
}

module.exports = { isDbReady };
