#!/usr/bin/env node
"use strict";
// Thin CJS entrypoint. All logic (config resolution + hook behavior) lives in
// jev-hook-lib.js, GENERATED from src/jev-config.js + src/jev-hook-core.js by
// scripts/install-hook.mjs and installed next to this file. Keeping this file
// free of logic means there is exactly ONE config implementation, and it reads
// cline-jev.json only — no environment variables.
const lib = require("./jev-hook-lib.cjs");

lib.main().catch((e) => {
  lib
    .log({ event: "fail_open", error: String(e?.message || e) })
    .then(() => console.log(JSON.stringify({})));
});
