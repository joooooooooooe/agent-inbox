'use strict';

// Entry point so `node --test test/` works on Node builds that execute a
// matched directory as a module instead of scanning it. Pulls in the suite.
require('./store.test.js');
