'use strict';

// Entry point so `node --test test/` works on Node builds that execute a
// matched directory as a module instead of scanning it. Pulls in the suites.
require('./store.test.js');
require('./setup.test.js');
require('./open-file.test.js');
require('./linkify.test.js');
require('./server.test.js');
require('./markdown.test.js');
