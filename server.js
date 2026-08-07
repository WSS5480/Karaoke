// Loader: runs the highest-numbered app-vN.js in this folder.
// To update the app: just upload a new app-v<N+1>.js - never edit this file.
"use strict";
const fs = require("fs"), path = require("path");
const versions = fs.readdirSync(__dirname).filter(f => /^app-v(\d+)\.js$/.test(f));
if (!versions.length) { console.error("No app-vN.js found"); process.exit(1); }
versions.sort((a, b) => parseInt(b.match(/\d+/)[0], 10) - parseInt(a.match(/\d+/)[0], 10));
console.log("Loading " + versions[0]);
require(path.join(__dirname, versions[0]));
