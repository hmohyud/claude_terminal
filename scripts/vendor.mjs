// Copies the browser builds of mammoth (reads Word files) and docx (writes
// Word files) from node_modules into public/vendor. Run after upgrading them.
import fs from "node:fs";

fs.mkdirSync("public/vendor", { recursive: true });
fs.copyFileSync("node_modules/mammoth/mammoth.browser.min.js", "public/vendor/mammoth.browser.min.js");
fs.copyFileSync("node_modules/docx/dist/index.iife.js", "public/vendor/docx.iife.js");
console.log("copied mammoth.browser.min.js and docx.iife.js into public/vendor");
