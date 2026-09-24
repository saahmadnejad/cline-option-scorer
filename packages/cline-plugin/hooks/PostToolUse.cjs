#!/usr/bin/env node
"use strict";
// Thin CJS entrypoint for the PostToolUse hook — captures which option the
// user chose after ask_question/ask_followup_question, so the NEXT question's
// scoring can include it as context. All logic lives in jev-hook-lib.cjs
// (generated from src/, alongside this file).
const lib = require("./jev-hook-lib.cjs");

lib.postMain().catch(() => console.log(JSON.stringify({})));
